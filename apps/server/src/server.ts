import { existsSync, mkdirSync, readdirSync } from "node:fs";
import type { Server } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunSessionDeps } from "@governor/agent-host";
import { ClientToServer, type DialMode, type Session } from "@governor/contracts";
import { createNarrator } from "@governor/narrator";
import { SqliteStorage } from "@governor/store";
import { StructuralAnalyzer } from "@governor/structural";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { type CreateInput, SessionManager } from "./manager.ts";
import { serveWeb } from "./static.ts";

const DEFAULT_PORT = 4318;

export interface ServerOptions {
  port?: number;
  /** SQLite path. Defaults to `~/.governor/governor.db`; `:memory:` for ephemeral. */
  dbPath?: string;
  /** Absolute path to the built web bundle. Defaults to `apps/web/dist`. */
  webRoot?: string;
  /** Generate per-edit "why" narration (Haiku). Default on; off via GOVERNOR_NARRATE=0. */
  narrate?: boolean;
  /** Injectable SDK `query` for tests; used for every session. */
  queryImpl?: RunSessionDeps["queryImpl"];
  /** Optionally create one session at boot (the `governor run` single-shot path). */
  repoPath?: string;
  prompt?: string;
  mode?: DialMode;
}

export interface RunningServer {
  port: number;
  url: string;
  createSession(input: CreateInput): Session;
  close(): Promise<void>;
}

function defaultWebRoot(): string {
  return resolveFrom("../../web/dist");
}
function resolveFrom(rel: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), rel);
}

/** True for same-machine browser origins (any port) and non-browser clients (no Origin). */
function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

export async function startGovernorServer(opts: ServerOptions): Promise<RunningServer> {
  const dbPath = opts.dbPath ?? join(homedir(), ".governor", "governor.db");
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

  const store = new SqliteStorage(dbPath);
  const analyzer = await StructuralAnalyzer.create().catch(() => null);
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const narrationOn =
    (opts.narrate ?? !["0", "off", "false"].includes(process.env.GOVERNOR_NARRATE ?? "")) && hasKey;
  const narrator = narrationOn ? createNarrator() : null;

  const manager = new SessionManager({ store, analyzer, narrator, queryImpl: opts.queryImpl });
  if (opts.repoPath && opts.prompt) {
    manager.create({ repoPath: opts.repoPath, prompt: opts.prompt, mode: opts.mode });
  }

  const app = new Hono();
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    const local = isLocalOrigin(origin);
    if (origin && local) {
      c.header("access-control-allow-origin", origin);
      c.header("access-control-allow-headers", "content-type");
      c.header("access-control-allow-methods", "GET, POST");
    }
    if (c.req.method === "OPTIONS") return c.body(null, 204);
    // CSRF→RCE guard: POST /sessions spawns an agent. A browser always sends
    // Origin on a cross-origin request, so reject state-changing calls from any
    // non-local origin. (CLI/non-browser clients send no Origin and are trusted.)
    if (c.req.method !== "GET" && !local) return c.json({ error: "forbidden origin" }, 403);
    await next();
  });
  app.get("/healthz", (c) => c.json({ ok: true }));

  // Server-side directory picker for the New Session modal: the browser can't
  // hand us an absolute path, but the server runs on the same machine. Lists
  // subdirectories of `path` (defaults to home), marking those that are git repos.
  app.get("/fs", (c) => {
    const q = c.req.query("path");
    const path = q ? resolve(q) : homedir();
    try {
      const entries = readdirSync(path, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .map((d) => ({ name: d.name, isRepo: existsSync(join(path, d.name, ".git")) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const parent = dirname(path);
      return c.json({ path, parent: parent === path ? null : parent, entries });
    } catch {
      return c.json({ error: "cannot read directory" }, 400);
    }
  });

  app.get("/sessions", (c) => c.json(manager.list()));
  app.post("/sessions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<CreateInput>;
    if (!body.repoPath || !body.prompt) {
      return c.json({ error: "repoPath and prompt are required" }, 400);
    }
    try {
      return c.json(
        manager.create({
          repoPath: body.repoPath,
          prompt: body.prompt,
          mode: body.mode,
          worktree: body.worktree,
        }),
      );
    } catch (e) {
      // e.g. worktree requested on a non-git repo.
      return c.json({ error: (e as Error).message ?? "could not create session" }, 400);
    }
  });
  app.get("/*", serveWeb(opts.webRoot ?? defaultWebRoot()));

  let httpServer!: ReturnType<typeof serve>;
  const port = await new Promise<number>((res) => {
    // Bind to loopback only — never expose the agent-spawning API on the network.
    httpServer = serve(
      { fetch: app.fetch, port: opts.port ?? DEFAULT_PORT, hostname: "127.0.0.1" },
      (info) => res(info.port),
    );
  });

  // CSWSH guard: a browser always sends Origin; allow only local origins.
  const wss = new WebSocketServer({
    server: httpServer as unknown as Server,
    verifyClient: ({ origin }: { origin?: string }) => isLocalOrigin(origin),
  });
  wss.on("connection", (ws, req) => {
    // Per-connection session scoping: ws://…?session=<id>.
    const sessionId = new URL(req.url ?? "/", "http://localhost").searchParams.get("session");
    const gs = sessionId ? manager.get(sessionId) : undefined;
    if (!gs) {
      ws.close();
      return;
    }
    gs.addClient(ws);
    ws.on("message", (raw) => {
      const parsed = ClientToServer.safeParse(JSON.parse(String(raw)));
      if (parsed.success) gs.handle(parsed.data);
    });
  });

  return {
    port,
    url: `http://localhost:${port}`,
    createSession: (input) => manager.create(input),
    async close() {
      await manager.closeAll();
      wss.close();
      await new Promise<void>((res) => httpServer.close(() => res()));
      store.close();
    },
  };
}
