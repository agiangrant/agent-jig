import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentSDK, GateDecision } from "./agent-sdk.ts";
import { runReadOnly } from "./read-only.ts";

/** A fake adapter that probes the gate (write + read), then emits text + result. */
function fakeAdapter(rec: { write?: GateDecision; read?: GateDecision }): AgentSDK {
  return {
    run(opts) {
      async function* gen(): AsyncGenerator<AgentMessage> {
        rec.write = await opts.gate("Write", { file_path: "x.ts" });
        rec.read = await opts.gate("Read", { file_path: "y.ts" });
        yield { type: "reasoning", text: "part1" };
        yield { type: "reasoning", text: "part2" };
        yield { type: "result", raw: {} };
      }
      const g = gen();
      return {
        [Symbol.asyncIterator]: () => g,
        send() {},
        end() {},
        interrupt: async () => {},
      };
    },
  };
}

describe("runReadOnly", () => {
  it("denies writes, allows reads, and returns the accumulated text", async () => {
    const rec: { write?: GateDecision; read?: GateDecision } = {};
    const text = await runReadOnly(fakeAdapter(rec), { prompt: "review", cwd: "/r" });

    expect(text).toBe("part1\npart2");
    expect(rec.write?.allow).toBe(false);
    expect(rec.read).toEqual({ allow: true, updatedInput: { file_path: "y.ts" } });
  });
});
