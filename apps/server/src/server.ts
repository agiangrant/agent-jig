import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ClaudeAdapterDeps } from "@agent-jig/agent-host";
import { ClientToServer, type DialMode, type Session, SessionConfig } from "@agent-jig/contracts";
import { createNarrator } from "@agent-jig/narrator";
import { SqliteStorage } from "@agent-jig/store";
import { StructuralAnalyzer } from "@agent-jig/structural";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { loadAgentConfig, providerStatuses } from "./config.ts";
import { type CreateInput, SessionManager } from "./manager.ts";
import { listRepoFiles } from "./repo-files.ts";
import { listSkills } from "./skills.ts";
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
  /** SQLite path. Defaults to `~/.jig/jig.db`; `:memory:` for ephemeral. */
  dbPath?: string;
  /** Absolute path to the built web bundle. Defaults to `apps/web/dist`. */
  webRoot?: string;
  /** Generate per-edit "why" narration (Haiku). Default on; off via JIG_NARRATE=0. */
  narrate?: boolean;
  /** Injectable SDK `query` for tests; used for every session. */
  queryImpl?: ClaudeAdapterDeps["queryImpl"];
  /** Injectable native folder picker (tests stub it). Returns an abs path or null. */
  pickFolder?: () => Promise<string | null>;
  /** Optionally create one session at boot (the `jig run` single-shot path). */
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
  // The Tauri desktop shell serves the UI from a custom-scheme origin:
  // `tauri://localhost` (macOS/Linux) or `http(s)://tauri.localhost` (Windows).
  // It runs on this machine — treat it as local so the event-stream WS connects.
  if (origin.startsWith("tauri://")) return true;
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "tauri.localhost"
    );
  } catch {
    return false;
  }
}

export async function startJigServer(opts: ServerOptions): Promise<RunningServer> {
  const dbPath = opts.dbPath ?? join(homedir(), ".jig", "jig.db");
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

  const store = new SqliteStorage(dbPath);
  const analyzer = await StructuralAnalyzer.create().catch(() => null);
  // Narration/intent-labels need an LLM: Anthropic creds, or any OpenAI-compatible
  // endpoint (e.g. a local Ollama via JIG_LLM_BASE_URL).
  const hasLlm = Boolean(
    process.env.ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      process.env.JIG_LLM_BASE_URL,
  );
  const narrationOn =
    (opts.narrate ?? !["0", "off", "false"].includes(process.env.JIG_NARRATE ?? "")) && hasLlm;
  const narrator = narrationOn ? createNarrator() : null;

  const agentConfig = loadAgentConfig();
  const manager = new SessionManager({
    store,
    analyzer,
    narrator,
    queryImpl: opts.queryImpl,
    adapterConfig: agentConfig.adapterConfig,
  });
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
      c.header("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE");
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

  // Global governance config (risk rules, default dial, idle threshold). Read by
  // the gate at session/run start, so edits take effect for new gate decisions.
  app.get("/config", (c) => c.json(store.getConfig()));
  app.put("/config", async (c) => {
    const parsed = SessionConfig.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid config" }, 400);
    store.setConfig(parsed.data);
    return c.json(parsed.data);
  });

  // Which agent providers this server can run + default. Recomputed per request
  // so a CLI installed after start-up is detected without a server restart.
  app.get("/providers", (c) => {
    const s = providerStatuses();
    return c.json({ providers: s.statuses, default: s.defaultProvider });
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
          planMode: body.planMode,
          agentSdk: body.agentSdk,
          agentModel: body.agentModel,
          autoReview: body.autoReview,
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
  // Read a slice of a worktree file so the Review tab can expand context around an
  // edit (or preview a touched file). 1-indexed `from`/`to`; omit both (or `full`)
  // for the whole file. Path traversal is rejected inside readFileSlice.
  app.get("/sessions/:id/file", (c) => {
    const gs = manager.get(c.req.param("id"));
    if (!gs) return c.json({ error: "not found" }, 404);
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path is required" }, 400);
    const num = (v: string | undefined) => (v ? Number(v) : undefined);
    const full = c.req.query("full");
    try {
      const from = full ? undefined : num(c.req.query("from"));
      const to = full ? undefined : num(c.req.query("to"));
      return c.json(gs.readFileSlice(path, from, to));
    } catch (e) {
      return c.json({ error: (e as Error).message ?? "could not read file" }, 400);
    }
  });
  // Stateless repo introspection for the New Session composer, which needs
  // @file / /skill autocomplete before any session (and its websocket) exists.
  // A bad/non-git path yields an empty list rather than an error.
  app.get("/repo/files", (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path is required" }, 400);
    return c.json({ files: listRepoFiles(path) });
  });
  app.get("/repo/skills", (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path is required" }, 400);
    return c.json({ skills: listSkills(path) });
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
