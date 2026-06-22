import { LspClient } from "./client.ts";
import { isInstallable, resolveServer } from "./install.ts";
import { descriptorForPath, type ServerDescriptor } from "./registry.ts";

const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
const MAX_RESTARTS = 3;

interface Entry {
  client: LspClient | null;
  desc: ServerDescriptor;
  restarts: number;
  idleTimer: NodeJS.Timeout | null;
}

/** What a file's language offers, resolved lazily. */
export interface ServerHandle {
  client: LspClient;
  languageId: string;
}

/** Why no server is available — drives the UI's degraded/install affordance. */
export interface NoServer {
  serverId: string;
  installable: boolean;
}

/**
 * One pool per session (keyed on the worktree root). Servers are spawned lazily —
 * only for languages a focused file actually needs — reused across requests, shut
 * down when idle, and restarted with a bounded budget on crash before degrading.
 */
export class LspManager {
  private readonly servers = new Map<string, Entry>();

  constructor(private readonly repoRoot: string) {}

  /**
   * A ready server for `absFile`'s language, or a NoServer describing why not
   * (so the caller can degrade to tree-sitter and offer an install).
   */
  async handleFor(absFile: string): Promise<ServerHandle | NoServer> {
    const desc = descriptorForPath(absFile);
    if (!desc) return { serverId: "", installable: false };

    const existing = this.servers.get(desc.serverId);
    if (existing?.client?.isAlive) {
      this.touch(existing);
      await existing.client.initialize();
      return { client: existing.client, languageId: desc.languageId(ext(absFile)) };
    }

    const resolved = resolveServer(desc, this.repoRoot);
    if (!resolved) return { serverId: desc.serverId, installable: isInstallable(desc) };

    const entry: Entry = existing ?? { client: null, desc, restarts: 0, idleTimer: null };
    if (entry.restarts > MAX_RESTARTS) {
      return { serverId: desc.serverId, installable: isInstallable(desc) };
    }

    const client = new LspClient(resolved.command, resolved.args, this.repoRoot, () => {
      // On crash, drop the client so the next request respawns (counting restarts).
      const e = this.servers.get(desc.serverId);
      if (e) {
        e.client = null;
        e.restarts++;
      }
    });
    entry.client = client;
    this.servers.set(desc.serverId, entry);
    this.touch(entry);
    try {
      await client.initialize();
    } catch {
      client.dispose();
      entry.client = null;
      entry.restarts++;
      return { serverId: desc.serverId, installable: isInstallable(desc) };
    }
    return { client, languageId: desc.languageId(ext(absFile)) };
  }

  private touch(entry: Entry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      entry.client?.dispose();
      entry.client = null;
    }, IDLE_SHUTDOWN_MS);
    entry.idleTimer.unref?.();
  }

  dispose(): void {
    for (const e of this.servers.values()) {
      if (e.idleTimer) clearTimeout(e.idleTimer);
      e.client?.dispose();
    }
    this.servers.clear();
  }
}

function ext(path: string): string {
  const i = path.lastIndexOf(".");
  return i === -1 ? "" : path.slice(i).toLowerCase();
}
