import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type RunSessionDeps, runGovernedSession } from "@governor/agent-host";
import { ClientToServer, type DialMode, type Session } from "@governor/contracts";
import { Pacer } from "@governor/core";
import { SqliteStorage } from "@governor/store";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { Broadcaster } from "./broadcaster.ts";
import { serveWeb } from "./static.ts";

const DEFAULT_PORT = 4318;

export interface ServerOptions {
  repoPath: string;
  prompt: string;
  port?: number;
  /** SQLite path. Defaults to `<repo>/.governor/governor.db`; `:memory:` for ephemeral. */
  dbPath?: string;
  mode?: DialMode;
  /** Absolute path to the built web bundle. Defaults to `apps/web/dist`. */
  webRoot?: string;
  /** Injectable SDK `query` for tests. */
  queryImpl?: RunSessionDeps["queryImpl"];
}

export interface RunningServer {
  port: number;
  url: string;
  session: Session;
  /** Resolves when the governed agent session finishes. */
  done: Promise<void>;
  close(): Promise<void>;
}

function defaultWebRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
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
  const repoPath = resolve(opts.repoPath);
  const dbPath = opts.dbPath ?? join(repoPath, ".governor", "governor.db");
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

  const store = new SqliteStorage(dbPath);
  const pacer = new Pacer(opts.mode ?? store.getConfig().defaultMode);
  const broadcaster = new Broadcaster();
  const session = store.createSession({ repoPath, taskPrompt: opts.prompt });

  pacer.onQueueChange = (pending) => broadcaster.broadcast({ type: "queue_state", pending });
  pacer.onModeChange = (mode) => {
    store.appendEvent({ sessionId: session.id, type: "dial_change", payload: { mode } });
    broadcaster.broadcast({ type: "dial_state", mode });
  };

  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true, session: session.id }));
  app.get("/*", serveWeb(opts.webRoot ?? defaultWebRoot()));

  let httpServer!: ReturnType<typeof serve>;
  const port = await new Promise<number>((res) => {
    httpServer = serve({ fetch: app.fetch, port: opts.port ?? DEFAULT_PORT }, (info) =>
      res(info.port),
    );
  });

  // Reject Cross-Site WebSocket Hijacking: a browser always sends Origin on the
  // handshake, so an allowlist of local origins blocks pages on remote sites from
  // reading the event log or driving the gate. Non-browser clients (CLI, tests)
  // send no Origin and are trusted, since they already have local machine access.
  const wss = new WebSocketServer({
    server: httpServer as unknown as Server,
    verifyClient: ({ origin }: { origin?: string }) => isLocalOrigin(origin),
  });
  wss.on("connection", (ws) => {
    // Snapshot the current state so a late joiner catches up (synchronous: no event can interleave).
    broadcaster.send(ws, { type: "session_state", session });
    broadcaster.send(ws, { type: "dial_state", mode: pacer.mode });
    broadcaster.send(ws, { type: "queue_state", pending: pacer.queue });
    for (const event of store.listEvents(session.id))
      broadcaster.send(ws, { type: "event", event });
    broadcaster.add(ws);

    ws.on("message", (raw) => {
      const parsed = ClientToServer.safeParse(JSON.parse(String(raw)));
      if (!parsed.success) return;
      const msg = parsed.data;
      if (msg.type === "set_dial") pacer.setMode(msg.mode);
      else if (msg.type === "ack_edit") pacer.ack(msg.editId);
    });
  });

  const running = runGovernedSession({
    session,
    prompt: opts.prompt,
    pacer,
    store,
    onEvent: (event) => broadcaster.broadcast({ type: "event", event }),
    queryImpl: opts.queryImpl,
  });

  return {
    port,
    url: `http://localhost:${port}`,
    session,
    done: running.result,
    async close() {
      await running.interrupt().catch(() => {});
      wss.close();
      await new Promise<void>((res) => httpServer.close(() => res()));
      store.close();
    },
  };
}
