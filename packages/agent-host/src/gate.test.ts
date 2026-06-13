import { Pacer } from "@governor/core";
import { SqliteStorage } from "@governor/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCanUseTool } from "./gate.ts";

const signal = new AbortController().signal;
const opts = { signal, toolUseID: "test-tool-use-id" };
const tick = () => new Promise((r) => setTimeout(r, 0));

let store: SqliteStorage;
let sessionId: string;

beforeEach(() => {
  store = new SqliteStorage(":memory:");
  sessionId = store.createSession({ repoPath: "/repo", taskPrompt: "t" }).id;
});

afterEach(() => {
  store.close();
});

describe("makeCanUseTool", () => {
  it("blocks a write in slowed mode until the human acks, logging tool_call then ack", async () => {
    const pacer = new Pacer("slowed");
    const gate = makeCanUseTool({ sessionId, pacer, store });

    const decision = gate("Edit", { file_path: "src/auth/login.ts" }, opts);
    await tick();

    expect(pacer.queue).toHaveLength(1);
    const pending = pacer.queue[0];
    expect(pending?.path).toBe("src/auth/login.ts");
    expect(pending?.risk).toBeGreaterThan(0); // auth glob scored as high risk

    // The decision promise is still unresolved while the edit waits.
    expect(store.listEvents(sessionId).map((e) => e.type)).toEqual(["tool_call"]);
    expect(store.listEvents(sessionId)[0]?.gateState).toBe("pending");

    pacer.ack(pending?.editId ?? "");
    await expect(decision).resolves.toEqual({
      behavior: "allow",
      updatedInput: { file_path: "src/auth/login.ts" },
    });

    const events = store.listEvents(sessionId);
    expect(events.map((e) => e.type)).toEqual(["tool_call", "ack"]);
    expect(events[1]?.gateState).toBe("released");
    expect(events[1]?.editId).toBe(pending?.editId);
  });

  it("lets read-class tools pass immediately and does not enqueue them", async () => {
    const pacer = new Pacer("slowed");
    const gate = makeCanUseTool({ sessionId, pacer, store });

    await expect(gate("Read", { file_path: "src/a.ts" }, opts)).resolves.toEqual({
      behavior: "allow",
      updatedInput: { file_path: "src/a.ts" },
    });
    expect(pacer.queue).toEqual([]);

    const events = store.listEvents(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("tool_call");
    expect(events[0]?.gateState).toBe("open");
    expect(events[0]?.editId).toBeNull();
  });

  it("passes writes straight through in realtime with no ack event", async () => {
    const pacer = new Pacer("realtime");
    const gate = makeCanUseTool({ sessionId, pacer, store });

    await expect(gate("Write", { file_path: "README.md" }, opts)).resolves.toEqual({
      behavior: "allow",
      updatedInput: { file_path: "README.md" },
    });
    expect(pacer.queue).toEqual([]);

    const events = store.listEvents(sessionId);
    expect(events.map((e) => e.type)).toEqual(["tool_call"]);
    expect(events[0]?.gateState).toBe("open");
  });

  it("emits each appended event through onEvent", async () => {
    const pacer = new Pacer("slowed");
    const seen: string[] = [];
    const gate = makeCanUseTool({ sessionId, pacer, store, onEvent: (e) => seen.push(e.type) });

    const decision = gate("Edit", { file_path: "src/x.ts" }, opts);
    await tick();
    pacer.ack(pacer.queue[0]?.editId ?? "");
    await decision;

    expect(seen).toEqual(["tool_call", "ack"]);
  });
});
