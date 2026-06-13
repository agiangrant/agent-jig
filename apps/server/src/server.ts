import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type RunSessionDeps, runGovernedSession } from "@governor/agent-host";
import {
  ClientToServer,
  type DialMode,
  type GovernorEvent,
  type Session,
} from "@governor/contracts";
import { isWriteClass, Pacer } from "@governor/core";
import { createNarrator } from "@governor/narrator";
import { SqliteStorage } from "@governor/store";
import { StructuralAnalyzer } from "@governor/structural";
import { Worktree } from "@governor/worktree";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { Broadcaster } from "./broadcaster.ts";
import { buildChangeView } from "./changeView.ts";
import { serveWeb } from "./static.ts";

const DEFAULT_PORT = 4318;

export interface ServerOptions {
  repoPath: string;
  prompt: string;
  port?: number;
  /** SQLite path. Defaults to `<repo>/.governor/governor.db`; `:memory:` for ephemeral. */
  dbPath?: string;
  mode?: DialMode;
  /** Generate per-edit "why" narration (Haiku). Default on; off via GOVERNOR_NARRATE=0. */
  narrate?: boolean;
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

  // The change view's AST analysis is best-effort: if the WASM grammars fail to
  // load, groups still render without collapse/outlier marks.
  const analyzer = await StructuralAnalyzer.create().catch(() => null);
  const changeView = () => buildChangeView(store.listEvents(session.id), analyzer);
  const broadcastChangeView = () =>
    broadcaster.broadcast({ type: "change_view", view: changeView() });

  // Narration uses the base Anthropic SDK (fast, one call/edit) and needs an
  // ANTHROPIC_API_KEY/AUTH_TOKEN — separate from the agent's CLI auth. Without
  // one, leave it off rather than firing a failing call per edit.
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const narrationOn =
    (opts.narrate ?? !["0", "off", "false"].includes(process.env.GOVERNOR_NARRATE ?? "")) && hasKey;
  const narrator = narrationOn ? createNarrator() : null;

  // Generate a per-edit "why" off the hot path; emit it as a narration event when ready.
  const narrate = (event: GovernorEvent): void => {
    if (narrator === null || event.type !== "tool_call" || event.editId === null) return;
    if (!isWriteClass(event.toolName ?? "")) return;
    const editId = event.editId;
    const p = (event.payload ?? {}) as {
      file_path?: string;
      old_string?: string;
      new_string?: string;
      content?: string;
    };
    void (async () => {
      const prior = store.listEvents(session.id);
      const reasoning = [...prior]
        .reverse()
        .find((e) => e.type === "reasoning" && e.seq < event.seq);
      const text = await narrator.narrate({
        toolName: event.toolName ?? "",
        path: p.file_path ?? "",
        before: p.old_string ?? "",
        after: p.new_string ?? p.content ?? "",
        reasoning: ((reasoning?.payload ?? {}) as { text?: string }).text ?? "",
      });
      if (text !== null) {
        const ev = store.appendEvent({
          sessionId: session.id,
          type: "narration",
          editId,
          payload: { text },
        });
        broadcaster.broadcast({ type: "event", event: ev });
      }
    })();
  };

  const onEvent = (event: GovernorEvent) => {
    broadcaster.broadcast({ type: "event", event });
    // Grouping and analysis only shift on reasoning and edits.
    if (event.type === "reasoning" || event.type === "tool_call") broadcastChangeView();
    narrate(event);
  };

  pacer.onQueueChange = (pending) => broadcaster.broadcast({ type: "queue_state", pending });
  pacer.onModeChange = (mode) => {
    store.appendEvent({ sessionId: session.id, type: "dial_change", payload: { mode } });
    broadcaster.broadcast({ type: "dial_state", mode });
  };

  const running = runGovernedSession({
    session,
    prompt: opts.prompt,
    pacer,
    store,
    worktree: new Worktree(repoPath),
    onEvent,
    queryImpl: opts.queryImpl,
  });

  // Inject a human directive into the agent, anchored to an edit's path when given.
  const sendDirective = (text: string, anchorEditId: string | null) => {
    let composed = text;
    if (anchorEditId !== null) {
      const call = store
        .listEvents(session.id)
        .find((e) => e.type === "tool_call" && e.editId === anchorEditId);
      const path = ((call?.payload ?? {}) as { file_path?: string }).file_path;
      if (path) composed = `Re: your edit to ${path} — ${text}`;
    }
    running.sendDirective(composed);
    const event = store.appendEvent({
      sessionId: session.id,
      type: "directive",
      editId: anchorEditId,
      payload: { text: composed },
    });
    broadcaster.broadcast({ type: "event", event });
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
    broadcaster.send(ws, { type: "change_view", view: changeView() });
    broadcaster.add(ws);

    ws.on("message", (raw) => {
      const parsed = ClientToServer.safeParse(JSON.parse(String(raw)));
      if (!parsed.success) return;
      const msg = parsed.data;
      if (msg.type === "set_dial") pacer.setMode(msg.mode);
      else if (msg.type === "ack_edit") pacer.ack(msg.editId);
      else if (msg.type === "send_directive") sendDirective(msg.text, msg.anchorEditId);
    });
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
