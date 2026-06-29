import { describe, expect, it } from "vitest";
import { AsyncQueue } from "./async-queue.ts";

async function collect<T>(q: AsyncQueue<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of q) out.push(v);
  return out;
}

describe("AsyncQueue", () => {
  it("yields values pushed before iteration, then ends", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.end();
    expect(await collect(q)).toEqual([1, 2]);
  });

  it("delivers a value pushed while a consumer is waiting", async () => {
    const q = new AsyncQueue<string>();
    const collected = collect(q);
    // Let the consumer reach the awaiting state before pushing.
    await Promise.resolve();
    q.push("a");
    q.push("b");
    q.end();
    expect(await collected).toEqual(["a", "b"]);
  });

  it("drops pushes after end() and reports idle", () => {
    const q = new AsyncQueue<number>();
    expect(q.idle).toBe(true);
    q.push(1);
    expect(q.idle).toBe(false);
    q.end();
    q.push(2); // ignored
    expect(q.idle).toBe(false); // the unread 1 is still queued
  });
});
