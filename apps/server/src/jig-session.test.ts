import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeGraphProvider } from "@agent-jig/codegraph";
import type { ServerToClient } from "@agent-jig/contracts";
import { SqliteStorage } from "@agent-jig/store";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { JigSession, type JigSessionDeps } from "./jig-session.ts";

/** A minimal WebSocket stand-in that records the messages the server fans out. */
function fakeClient(): { ws: WebSocket; messages: ServerToClient[] } {
  const messages: ServerToClient[] = [];
  const ws = {
    OPEN: 1,
    readyState: 1,
    send: (data: string) => messages.push(JSON.parse(data) as ServerToClient),
    on: () => {},
  };
  return { ws: ws as unknown as WebSocket, messages };
}

const waitFor = async (pred: () => boolean, ms = 1000): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** Records the `resume` option and first pushed message of every query() call. */
function recordingQuery(
  rec: { resumes: (string | undefined)[]; firstMessages: string[] },
  sessionId = "claude-1",
): JigSessionDeps["queryImpl"] {
  return ((args: {
    prompt: AsyncIterable<unknown>;
    options?: { resume?: string; canUseTool?: unknown };
  }) => {
    // The Sidecar shares this queryImpl; only the gated agent run carries canUseTool.
    const isAgent = Boolean(args.options?.canUseTool);
    if (isAgent) rec.resumes.push(args.options?.resume);
    let first = true;
    async function* gen() {
      yield { type: "system", subtype: "init", session_id: sessionId };
      for await (const msg of args.prompt) {
        const content = (msg as { message?: { content?: unknown } }).message?.content;
        if (isAgent && first) {
          rec.firstMessages.push(typeof content === "string" ? content : "");
          first = false;
        }
        yield { type: "result", subtype: "success", session_id: sessionId };
      }
    }
    return Object.assign(gen(), {
      interrupt: async () => {},
      setPermissionMode: async () => {},
      setModel: async () => {},
    });
  }) as unknown as JigSessionDeps["queryImpl"];
}

let gs: JigSession;
let store: SqliteStorage;
afterEach(async () => {
  await gs?.close();
  store?.close();
});

describe("JigSession stop & resume", () => {
  it("finishes a turn, then resumes the saved SDK session on the next directive", async () => {
    store = new SqliteStorage(":memory:");
    const session = store.createSession({ repoPath: tmpdir(), taskPrompt: "do the thing" });
    const rec = { resumes: [] as (string | undefined)[], firstMessages: [] as string[] };
    gs = new JigSession({
      session,
      store,
      analyzer: null,
      narrator: null,
      queryImpl: recordingQuery(rec),
    });

    await waitFor(() => gs.meta().status === "done");
    expect(rec.resumes).toEqual([undefined]); // fresh run, no resume
    expect(rec.firstMessages).toEqual(["do the thing"]);
    expect(store.getClaudeSessionId(session.id)).toBe("claude-1");
    expect(gs.summary().resumable).toBe(true);

    // Steering a finished session resumes it with the directive as the next turn.
    gs.handle({ type: "send_directive", text: "now the next thing", anchorEditId: null });
    expect(rec.resumes[1]).toBe("claude-1"); // re-attached to the saved session
    expect(gs.meta().status).toBe("running"); // back to live immediately
    await waitFor(() => rec.firstMessages.length === 2);
    expect(rec.firstMessages[1]).toBe("now the next thing"); // directive is the next turn
    await waitFor(() => gs.meta().status === "done");
  });

  it("stops a running agent and marks the session paused (resumable)", async () => {
    store = new SqliteStorage(":memory:");
    const session = store.createSession({ repoPath: tmpdir(), taskPrompt: "long task" });
    let interrupted = false;
    const queryImpl = ((args: { prompt: AsyncIterable<unknown> }) => {
      async function* gen() {
        yield { type: "system", subtype: "init", session_id: "claude-2" };
        for await (const _ of args.prompt) {
          /* consume input but never emit a result → the run stays live */
        }
      }
      return Object.assign(gen(), {
        interrupt: async () => {
          interrupted = true;
        },
        setPermissionMode: async () => {},
        setModel: async () => {},
      });
    }) as unknown as JigSessionDeps["queryImpl"];

    gs = new JigSession({ session, store, analyzer: null, narrator: null, queryImpl });
    // Runs indefinitely (no result emitted) until we stop it.
    await waitFor(() => store.getClaudeSessionId(session.id) === "claude-2");
    expect(gs.meta().status).toBe("running");

    gs.stop();
    await waitFor(() => gs.meta().status === "paused");
    expect(interrupted).toBe(true);
  });
});

describe("JigSession.readFileSlice", () => {
  function detachedSession(repoPath: string): JigSession {
    store = new SqliteStorage(":memory:");
    const session = store.createSession({ repoPath, taskPrompt: "x" });
    return new JigSession({ session, store, analyzer: null, narrator: null, detached: true });
  }

  it("returns the whole file with totalLines, or a 1-indexed inclusive slice", () => {
    const dir = mkdtempSync(join(tmpdir(), "gov-file-"));
    writeFileSync(join(dir, "a.ts"), "l1\nl2\nl3\nl4\nl5");
    gs = detachedSession(dir);

    const full = gs.readFileSlice("a.ts");
    expect(full.totalLines).toBe(5);
    expect(full.lines).toEqual(["l1", "l2", "l3", "l4", "l5"]);
    expect(full).toMatchObject({ from: 1, to: 5 });

    const mid = gs.readFileSlice("a.ts", 2, 4);
    expect(mid.lines).toEqual(["l2", "l3", "l4"]);
    expect(mid).toMatchObject({ from: 2, to: 4, totalLines: 5 });

    // `to` past EOF clamps to the last line.
    expect(gs.readFileSlice("a.ts", 4, 99).lines).toEqual(["l4", "l5"]);
  });

  it("rejects path traversal outside the worktree", () => {
    const dir = mkdtempSync(join(tmpdir(), "gov-file-"));
    writeFileSync(join(dir, "a.ts"), "ok");
    gs = detachedSession(dir);
    expect(() => gs.readFileSlice("../../etc/passwd")).toThrow(/escapes/);
    expect(() => gs.readFileSlice("/etc/passwd")).toThrow(/escapes/);
  });

  it("rejects a symlink inside the worktree that points outside it", () => {
    const outside = mkdtempSync(join(tmpdir(), "gov-outside-"));
    writeFileSync(join(outside, "secret.txt"), "top secret");
    const dir = mkdtempSync(join(tmpdir(), "gov-file-"));
    symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));
    gs = detachedSession(dir);
    expect(() => gs.readFileSlice("link.txt")).toThrow(/escapes/);
  });
});

describe("JigSession impact map", () => {
  it("computes and broadcasts the impact map for a focused file via the provider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gov-impact-"));
    writeFileSync(join(dir, "a.ts"), "export const x = 1");
    writeFileSync(join(dir, "lib.ts"), "export const y = 2");
    writeFileSync(join(dir, "dep.ts"), "import { x } from './a'");
    store = new SqliteStorage(":memory:");
    const session = store.createSession({ repoPath: dir, taskPrompt: "x" });
    const provider: CodeGraphProvider = {
      dependencies: async () => [{ path: join(dir, "lib.ts") }],
      dependents: async () => [{ path: join(dir, "dep.ts"), reachedByEdit: true }],
      capabilities: () => ({ references: true }),
    };
    gs = new JigSession({
      session,
      store,
      analyzer: null,
      narrator: null,
      detached: true,
      impactProvider: provider,
    });

    const { ws, messages } = fakeClient();
    gs.addClient(ws);
    messages.length = 0; // drop the initial snapshot
    gs.handle({ type: "request_impact", path: "a.ts" });

    await waitFor(() => messages.some((m) => m.type === "impact_map"));
    const msg = messages.find((m) => m.type === "impact_map");
    const map = msg?.type === "impact_map" ? msg.map : null;
    // The message echoes the exact requested path so the client can match it even
    // when (unlike here) the agent's file_path is absolute and map.focus is not.
    expect(msg?.type === "impact_map" ? msg.requested : null).toBe("a.ts");
    expect(map?.focus).toBe("a.ts");
    expect(map?.degraded).toBe(false);
    expect(map?.rippleCount).toBe(1);
    expect(map?.nodes.find((n) => n.kind === "it-imports")?.label).toBe("lib.ts");
    expect(map?.nodes.find((n) => n.kind === "imports-it")?.label).toBe("dep.ts");
  });

  it("echoes an absolute request path even though map.focus is repo-relative", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gov-impact-"));
    writeFileSync(join(dir, "a.ts"), "export const x = 1");
    store = new SqliteStorage(":memory:");
    const session = store.createSession({ repoPath: dir, taskPrompt: "x" });
    gs = new JigSession({
      session,
      store,
      analyzer: null,
      narrator: null,
      detached: true,
      impactProvider: {
        dependencies: async () => [],
        dependents: async () => [],
        capabilities: () => ({ references: true }),
      },
    });
    const { ws, messages } = fakeClient();
    gs.addClient(ws);
    messages.length = 0;
    // The agent writes absolute file_paths — this is what the UI actually sends.
    const absolute = join(dir, "a.ts");
    gs.handle({ type: "request_impact", path: absolute });

    await waitFor(() => messages.some((m) => m.type === "impact_map"));
    const msg = messages.find((m) => m.type === "impact_map");
    expect(msg?.type === "impact_map" ? msg.requested : null).toBe(absolute); // matches what the client stored
    expect(msg?.type === "impact_map" ? msg.map?.focus : null).toBe("a.ts"); // but the map is repo-relative
  });

  it("serves a null map when the focused path escapes the worktree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gov-impact-"));
    store = new SqliteStorage(":memory:");
    const session = store.createSession({ repoPath: dir, taskPrompt: "x" });
    gs = new JigSession({
      session,
      store,
      analyzer: null,
      narrator: null,
      detached: true,
      impactProvider: {
        dependencies: async () => [],
        dependents: async () => [],
        capabilities: () => ({ references: true }),
      },
    });
    const { ws, messages } = fakeClient();
    gs.addClient(ws);
    messages.length = 0;
    gs.handle({ type: "request_impact", path: "../../etc/passwd" });
    await waitFor(() => messages.some((m) => m.type === "impact_map"));
    const msg = messages.find((m) => m.type === "impact_map");
    expect(msg?.type === "impact_map" ? msg.map : "unset").toBeNull();
  });
});
