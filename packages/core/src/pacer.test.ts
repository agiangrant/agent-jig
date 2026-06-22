import type { PendingEdit } from "@agent-jig/contracts";
import { describe, expect, it } from "vitest";
import { Pacer } from "./pacer.ts";

function edit(editId: string, seq: number): PendingEdit {
  return { editId, toolName: "Edit", path: `src/${editId}.ts`, seq, risk: 0.5 };
}

/** Resolves true if `p` settles within a macrotask, false if still pending. */
function settledSoon<T>(p: Promise<T>): Promise<boolean> {
  return Promise.race([
    p.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 10)),
  ]);
}

describe("Pacer", () => {
  it("passes writes straight through in realtime", async () => {
    const pacer = new Pacer("realtime");
    await expect(pacer.requestGate(edit("a", 1))).resolves.toEqual({ state: "open" });
    expect(pacer.queue).toEqual([]);
  });

  it("blocks a write in slowed mode until acked", async () => {
    const pacer = new Pacer("slowed");
    const gate = pacer.requestGate(edit("a", 1));

    expect(await settledSoon(gate)).toBe(false);
    expect(pacer.queue).toHaveLength(1);
    expect(pacer.isPending("a")).toBe(true);

    expect(pacer.ack("a")).toBe(true);
    await expect(gate).resolves.toEqual({ state: "released" });
    expect(pacer.queue).toEqual([]);
  });

  it("rejects a write with the developer's reason", async () => {
    const pacer = new Pacer("slowed");
    const gate = pacer.requestGate(edit("a", 1));
    expect(pacer.reject("a", "use the existing helper instead")).toBe(true);
    await expect(gate).resolves.toEqual({
      state: "rejected",
      reason: "use the existing helper instead",
    });
    expect(pacer.queue).toEqual([]);
  });

  it("orders the queue by seq regardless of arrival order", () => {
    const pacer = new Pacer("slowed");
    void pacer.requestGate(edit("c", 3));
    void pacer.requestGate(edit("a", 1));
    void pacer.requestGate(edit("b", 2));
    expect(pacer.queue.map((e) => e.editId)).toEqual(["a", "b", "c"]);
  });

  it("drains the whole queue as bypassed when opened to realtime", async () => {
    const pacer = new Pacer("slowed");
    const g1 = pacer.requestGate(edit("a", 1));
    const g2 = pacer.requestGate(edit("b", 2));

    pacer.setMode("realtime");

    await expect(g1).resolves.toEqual({ state: "bypassed" });
    await expect(g2).resolves.toEqual({ state: "bypassed" });
    expect(pacer.queue).toEqual([]);
  });

  it("force-gates a high-risk edit even in realtime, then acks", async () => {
    const pacer = new Pacer("realtime");
    const gate = pacer.requestGate(edit("a", 1), { force: true });

    expect(await settledSoon(gate)).toBe(false);
    expect(pacer.queue).toHaveLength(1);
    expect(pacer.isPending("a")).toBe(true);

    expect(pacer.ack("a")).toBe(true);
    await expect(gate).resolves.toEqual({ state: "released" });
  });

  it("keeps a force-gated edit held when the dial opens to realtime", async () => {
    const pacer = new Pacer("slowed");
    const normal = pacer.requestGate(edit("a", 1));
    const forced = pacer.requestGate(edit("b", 2), { force: true });

    pacer.setMode("realtime");

    await expect(normal).resolves.toEqual({ state: "bypassed" });
    expect(await settledSoon(forced)).toBe(false); // still held
    expect(pacer.queue.map((e) => e.editId)).toEqual(["b"]);

    pacer.reject("b", "too risky");
    await expect(forced).resolves.toEqual({ state: "rejected", reason: "too risky" });
  });

  it("acking or rejecting an unknown edit is a no-op", () => {
    const pacer = new Pacer("slowed");
    expect(pacer.ack("nope")).toBe(false);
    expect(pacer.reject("nope", "x")).toBe(false);
  });

  it("notifies subscribers on queue and mode changes", async () => {
    const pacer = new Pacer("slowed");
    const queues: number[] = [];
    const modes: string[] = [];
    pacer.onQueueChange = (q) => queues.push(q.length);
    pacer.onModeChange = (m) => modes.push(m);

    const gate = pacer.requestGate(edit("a", 1));
    pacer.ack("a");
    await gate;
    pacer.setMode("realtime");

    expect(queues).toEqual([1, 0]);
    expect(modes).toEqual(["realtime"]);
  });
});
