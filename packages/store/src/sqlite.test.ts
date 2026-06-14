import { DEFAULT_CONFIG } from "@governor/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "./sqlite.ts";

let store: SqliteStorage;

beforeEach(() => {
  store = new SqliteStorage(":memory:");
});

afterEach(() => {
  store.close();
});

describe("SqliteStorage", () => {
  it("creates and reads back a session", () => {
    const session = store.createSession({ repoPath: "/tmp/repo", taskPrompt: "do a thing" });
    expect(session.status).toBe("running");
    expect(session.title).toBeNull();
    expect(store.getSession(session.id)).toEqual(session);
    expect(store.getSession("missing")).toBeNull();
  });

  it("sets and reads back a session title", () => {
    const session = store.createSession({
      repoPath: "/tmp/repo",
      taskPrompt: "build the importer",
    });
    store.setSessionTitle(session.id, "XLSX importer");
    expect(store.getSession(session.id)?.title).toBe("XLSX importer");
  });

  it("assigns monotonic per-session seq numbers", () => {
    const a = store.createSession({ repoPath: "/a", taskPrompt: "t" });
    const b = store.createSession({ repoPath: "/b", taskPrompt: "t" });

    const a1 = store.appendEvent({ sessionId: a.id, type: "session_start", payload: {} });
    const a2 = store.appendEvent({
      sessionId: a.id,
      type: "tool_call",
      payload: {},
      toolName: "Edit",
    });
    const b1 = store.appendEvent({ sessionId: b.id, type: "session_start", payload: {} });

    expect(a1.seq).toBe(1);
    expect(a2.seq).toBe(2);
    expect(b1.seq).toBe(1); // seq is per-session
  });

  it("round-trips a payload and all event fields", () => {
    const s = store.createSession({ repoPath: "/r", taskPrompt: "t" });
    const stored = store.appendEvent({
      sessionId: s.id,
      type: "tool_call",
      toolName: "Edit",
      editId: "edit-1",
      risk: 0.9,
      gateState: "pending",
      payload: { file_path: "src/a.ts", nested: { ok: true } },
    });

    const [read] = store.listEvents(s.id);
    expect(read).toEqual(stored);
    expect(read?.payload).toEqual({ file_path: "src/a.ts", nested: { ok: true } });
    expect(read?.risk).toBe(0.9);
    expect(read?.gateState).toBe("pending");
  });

  it("lists events ordered by seq", () => {
    const s = store.createSession({ repoPath: "/r", taskPrompt: "t" });
    store.appendEvent({ sessionId: s.id, type: "session_start", payload: {} });
    store.appendEvent({ sessionId: s.id, type: "tool_call", payload: {}, toolName: "Write" });
    store.appendEvent({ sessionId: s.id, type: "session_end", payload: {} });
    expect(store.listEvents(s.id).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("returns the default config until one is set, then persists it", () => {
    expect(store.getConfig()).toEqual(DEFAULT_CONFIG);
    const next = { ...DEFAULT_CONFIG, defaultMode: "realtime" as const };
    store.setConfig(next);
    expect(store.getConfig()).toEqual(next);
  });

  it("updates session status and end time", () => {
    const s = store.createSession({ repoPath: "/r", taskPrompt: "t" });
    store.setSessionStatus(s.id, "done", 123);
    const read = store.getSession(s.id);
    expect(read?.status).toBe("done");
    expect(read?.endedAt).toBe(123);
  });
});
