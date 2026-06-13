import { describe, expect, it } from "vitest";
import { InputStream } from "./input-stream.ts";

const text = (m: { message: { content: unknown } }) => m.message.content as string;

describe("InputStream", () => {
  it("yields a queued message, then one pushed while the consumer awaits, then ends", async () => {
    const s = new InputStream();
    s.push("first");
    const it = s[Symbol.asyncIterator]();

    const r1 = await it.next();
    expect(r1.done).toBe(false);
    expect(text(r1.value)).toBe("first");

    const pending = it.next(); // consumer now awaiting
    s.push("second");
    const r2 = await pending;
    expect(text(r2.value)).toBe("second");

    s.end();
    expect((await it.next()).done).toBe(true);
  });

  it("idle reflects the queue", () => {
    const s = new InputStream();
    expect(s.idle).toBe(true);
    s.push("x");
    expect(s.idle).toBe(false);
  });

  it("push after end is a no-op", async () => {
    const s = new InputStream();
    s.end();
    s.push("ignored");
    const it = s[Symbol.asyncIterator]();
    expect((await it.next()).done).toBe(true);
  });
});
