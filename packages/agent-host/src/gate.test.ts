import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pacer } from "@agent-jig/core";
import { SqliteStorage } from "@agent-jig/store";
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

  it("denies a write with the reason when the human rejects it", async () => {
    const pacer = new Pacer("slowed");
    const gate = makeCanUseTool({ sessionId, pacer, store });

    const decision = gate("Edit", { file_path: "src/x.ts" }, opts);
    await tick();
    pacer.reject(pacer.queue[0]?.editId ?? "", "use the existing helper");

    await expect(decision).resolves.toEqual({
      behavior: "deny",
      message: "use the existing helper",
    });
    const events = store.listEvents(sessionId);
    expect(events.map((e) => e.type)).toEqual(["tool_call", "ack"]);
    expect(events[1]?.gateState).toBe("rejected");
    expect((events[1]?.payload as { reason?: string }).reason).toBe("use the existing helper");
  });

  it("routes AskUserQuestion to the human and denies with their answer", async () => {
    const pacer = new Pacer("slowed");
    const answer = "The developer answered:\n- Library: PapaParse";
    const gate = makeCanUseTool({ sessionId, pacer, store, askQuestion: async () => answer });

    const decision = await gate("AskUserQuestion", { questions: [] }, opts);

    expect(decision).toEqual({ behavior: "deny", message: answer });
    const events = store.listEvents(sessionId);
    expect(events.map((e) => e.type)).toEqual(["tool_call"]);
    expect(events[0]?.gateState).toBe("open"); // resolved — no longer "pending"
    expect(pacer.queue).toEqual([]); // not a write — never enters the edit queue
  });

  it("annotates an Edit with the real start line from the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-"));
    writeFileSync(
      join(dir, "a.ts"),
      "const a = 1;\nconst b = 2;\nconst target = 3;\nconst d = 4;\n",
    );
    const pacer = new Pacer("realtime");
    const gate = makeCanUseTool({ sessionId, pacer, store, cwd: dir });

    await gate(
      "Edit",
      { file_path: "a.ts", old_string: "const target = 3;", new_string: "x" },
      opts,
    );

    const ev = store.listEvents(sessionId).find((e) => e.type === "tool_call");
    expect((ev?.payload as { startLine?: number }).startLine).toBe(3);
    rmSync(dir, { recursive: true, force: true });
  });

  it("auto-downshifts: a high-risk path gates even in realtime", async () => {
    const pacer = new Pacer("realtime");
    const gate = makeCanUseTool({ sessionId, pacer, store });

    const decision = gate("Edit", { file_path: "src/auth/login.ts" }, opts);
    await tick();

    // Held despite realtime — an explicit risk rule (auth) forces the gate.
    expect(pacer.queue).toHaveLength(1);
    expect(store.listEvents(sessionId)[0]?.gateState).toBe("pending");

    pacer.ack(pacer.queue[0]?.editId ?? "");
    await expect(decision).resolves.toEqual({
      behavior: "allow",
      updatedInput: { file_path: "src/auth/login.ts" },
    });
  });

  it("does not auto-downshift an ordinary path in realtime", async () => {
    const pacer = new Pacer("realtime");
    const gate = makeCanUseTool({ sessionId, pacer, store });

    // No matching risk rule → falls back to the global (realtime) mode, passes through.
    await expect(gate("Edit", { file_path: "src/util/x.ts" }, opts)).resolves.toEqual({
      behavior: "allow",
      updatedInput: { file_path: "src/util/x.ts" },
    });
    expect(pacer.queue).toEqual([]);
  });

  it("approves an ExitPlanMode plan — allows the tool", async () => {
    const pacer = new Pacer("realtime");
    const gate = makeCanUseTool({
      sessionId,
      pacer,
      store,
      reviewPlan: async () => ({ approved: true }),
    });

    const decision = await gate("ExitPlanMode", { plan: "1. do a thing" }, opts);

    expect(decision).toEqual({ behavior: "allow", updatedInput: { plan: "1. do a thing" } });
    const ev = store.listEvents(sessionId).find((e) => e.type === "tool_call");
    expect(ev?.gateState).toBe("open"); // resolved — not stuck "pending"
  });

  it("requesting plan changes denies with the feedback", async () => {
    const pacer = new Pacer("realtime");
    const gate = makeCanUseTool({
      sessionId,
      pacer,
      store,
      reviewPlan: async () => ({ approved: false, message: "split step 2 out" }),
    });

    const decision = await gate("ExitPlanMode", { plan: "p" }, opts);

    expect(decision).toEqual({ behavior: "deny", message: "split step 2 out" });
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
