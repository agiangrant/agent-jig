import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);

/**
 * Pop the OS folder chooser and return the picked absolute path (null if
 * cancelled / unavailable). A browser can't hand us a real filesystem path, but
 * the server runs on the same machine — so we drive the native dialog here.
 * macOS only for now; elsewhere the UI falls back to typing/pasting a path.
 */
async function nativePickFolder(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "Select a repository")',
    ]);
    return stdout.trim() || null;
  } catch {
    return null; // user cancelled, or no GUI session
  }
}

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
  /** Injectable native folder picker (tests stub it). Returns an abs path or null. */
  pickFolder?: () => Promise<string | null>;
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
  // Narration/intent-labels need an LLM: Anthropic creds, or any OpenAI-compatible
  // endpoint (e.g. a local Ollama via GOVERNOR_LLM_BASE_URL).
  const hasLlm = Boolean(
    process.env.ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      process.env.GOVERNOR_LLM_BASE_URL,
  );
  const narrationOn =
    (opts.narrate ?? !["0", "off", "false"].includes(process.env.GOVERNOR_NARRATE ?? "")) && hasLlm;
  const narrator = narrationOn ? createNarrator() : null;

  const manager = new SessionManager({ store, analyzer, narrator, queryImpl: opts.queryImpl });
  // Bring back sessions persisted from a previous run (e.g. a dev-server restart).
  manager.restore();
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
      c.header("access-control-allow-methods", "GET, POST, PATCH, DELETE");
    }
    if (c.req.method === "OPTIONS") return c.body(null, 204);
    // CSRF→RCE guard: POST /sessions spawns an agent. A browser always sends
    // Origin on a cross-origin request, so reject state-changing calls from any
    // non-local origin. (CLI/non-browser clients send no Origin and are trusted.)
    if (c.req.method !== "GET" && !local) return c.json({ error: "forbidden origin" }, 403);
    await next();
  });
  app.get("/healthz", (c) => c.json({ ok: true }));

  // Native folder picker for the New Session modal: pops the OS dialog on the
  // server (same machine as the browser) and returns the chosen absolute path.
  const pickFolder = opts.pickFolder ?? nativePickFolder;
  app.get("/pick-folder", async (c) => {
    const path = await pickFolder();
    if (!path) return c.json({ error: "no folder selected" }, 400);
    return c.json({ path });
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
  app.patch("/sessions/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { title?: string };
    const title = (body.title ?? "").trim();
    if (!title) return c.json({ error: "title is required" }, 400);
    return manager.rename(c.req.param("id"), title)
      ? c.body(null, 204)
      : c.json({ error: "not found" }, 404);
  });
  app.delete("/sessions/:id", async (c) => {
    await manager.remove(c.req.param("id"));
    return c.body(null, 204);
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
