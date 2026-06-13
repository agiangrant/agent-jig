import type { PendingEdit } from "@governor/contracts";
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
    await expect(pacer.requestGate(edit("a", 1))).resolves.toBe("open");
    expect(pacer.queue).toEqual([]);
  });

  it("blocks a write in slowed mode until acked", async () => {
    const pacer = new Pacer("slowed");
    const gate = pacer.requestGate(edit("a", 1));

    expect(await settledSoon(gate)).toBe(false);
    expect(pacer.queue).toHaveLength(1);
    expect(pacer.queue[0]?.editId).toBe("a");

    expect(pacer.ack("a")).toBe(true);
    await expect(gate).resolves.toBe("released");
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

    await expect(g1).resolves.toBe("bypassed");
    await expect(g2).resolves.toBe("bypassed");
    expect(pacer.queue).toEqual([]);
  });

  it("acking an unknown edit is a no-op", () => {
    const pacer = new Pacer("slowed");
    expect(pacer.ack("nope")).toBe(false);
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
