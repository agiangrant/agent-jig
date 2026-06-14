import { tmpdir } from "node:os";
import { SqliteStorage } from "@governor/store";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "./manager.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

// A query() stand-in that records its call args and completes with no messages.
function recordingQuery(calls: { options?: Record<string, unknown> }[]) {
  return ((args: { options?: Record<string, unknown> }) => {
    calls.push(args);
    async function* gen(): AsyncGenerator<never, void> {
      /* no messages */
    }
    return Object.assign(gen(), {
      interrupt: async () => {},
      setPermissionMode: async () => {},
      setModel: async () => {},
    });
  }) as unknown as ConstructorParameters<typeof SessionManager>[0]["queryImpl"];
}

// The agent-host call carries canUseTool; the sidecar's call does not.
const agentCalls = (calls: { options?: Record<string, unknown> }[]) =>
  calls.filter((c) => c.options?.canUseTool);

let store: SqliteStorage;
afterEach(() => store.close());

describe("SessionManager.restore", () => {
  it("resumes a recent running session that has a captured SDK id", async () => {
    store = new SqliteStorage(":memory:");
    const s = store.createSession({ repoPath: tmpdir(), taskPrompt: "t" });
    store.setClaudeSessionId(s.id, "claude-123");
    store.appendEvent({ sessionId: s.id, type: "session_start", payload: {} });

    const calls: { options?: Record<string, unknown> }[] = [];
    const mgr = new SessionManager({
      store,
      analyzer: null,
      narrator: null,
      queryImpl: recordingQuery(calls),
    });
    mgr.restore();

    expect(mgr.list().map((x) => x.id)).toContain(s.id);
    const agent = agentCalls(calls);
    expect(agent).toHaveLength(1);
    expect(agent[0]?.options?.resume).toBe("claude-123");

    await tick();
    await mgr.closeAll();
  });

  it("rehydrates a finished session detached (no agent run)", async () => {
    store = new SqliteStorage(":memory:");
    const s = store.createSession({ repoPath: tmpdir(), taskPrompt: "t" });
    store.setSessionStatus(s.id, "done", 1);

    const calls: { options?: Record<string, unknown> }[] = [];
    const mgr = new SessionManager({
      store,
      analyzer: null,
      narrator: null,
      queryImpl: recordingQuery(calls),
    });
    mgr.restore();

    expect(mgr.list().map((x) => x.id)).toContain(s.id);
    expect(agentCalls(calls)).toHaveLength(0); // detached: no agent
    await mgr.closeAll();
  });

  it("does not resume a stale running session — marks it paused", async () => {
    store = new SqliteStorage(":memory:");
    const s = store.createSession({ repoPath: tmpdir(), taskPrompt: "t" });
    store.setClaudeSessionId(s.id, "claude-1");
    const ev = store.appendEvent({ sessionId: s.id, type: "session_start", payload: {} });

    const calls: { options?: Record<string, unknown> }[] = [];
    const mgr = new SessionManager({
      store,
      analyzer: null,
      narrator: null,
      queryImpl: recordingQuery(calls),
    });
    // 7h after the last event — outside the 6h resume window.
    mgr.restore(ev.ts + 7 * 60 * 60 * 1000);

    expect(agentCalls(calls)).toHaveLength(0);
    expect(store.getSession(s.id)?.status).toBe("paused");
    await mgr.closeAll();
  });
});
