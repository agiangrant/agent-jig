import { Pacer } from "@governor/core";
import { SqliteStorage } from "@governor/store";
import { describe, expect, it } from "vitest";
import type { RunSessionDeps } from "./session.ts";
import { runGovernedSession } from "./session.ts";

// A query() stand-in that yields a fixed message stream and then completes.
function fakeQuery(messages: unknown[]): RunSessionDeps["queryImpl"] {
  return (() => {
    async function* gen() {
      for (const m of messages) yield m;
    }
    return Object.assign(gen(), {
      interrupt: async () => {},
      setPermissionMode: async () => {},
      setModel: async () => {},
    });
  }) as unknown as RunSessionDeps["queryImpl"];
}

describe("runGovernedSession", () => {
  it("captures assistant reasoning text as reasoning events", async () => {
    const store = new SqliteStorage(":memory:");
    const session = store.createSession({ repoPath: "/r", taskPrompt: "t" });

    const messages = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Wrapping this in a retry because the API rate-limits." },
            { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "a.ts" } },
          ],
        },
      },
      { type: "result", subtype: "success" },
    ];

    const running = runGovernedSession({
      session,
      prompt: "t",
      pacer: new Pacer("realtime"),
      store,
      queryImpl: fakeQuery(messages),
    });
    await running.result;

    const events = store.listEvents(session.id);
    const reasoning = events.find((e) => e.type === "reasoning");
    expect(reasoning).toBeDefined();
    expect((reasoning?.payload as { text: string }).text).toContain("rate-limits");
    store.close();
  });

  it("resumes a prior SDK session and reports its session id", async () => {
    const store = new SqliteStorage(":memory:");
    const session = store.createSession({ repoPath: "/r", taskPrompt: "original task" });

    let capturedResume: string | undefined;
    const queryImpl = ((args: { options?: { resume?: string } }) => {
      capturedResume = args.options?.resume;
      async function* gen() {
        yield { type: "system", subtype: "init", session_id: "claude-xyz" };
        yield { type: "result", subtype: "success", session_id: "claude-xyz" };
      }
      return Object.assign(gen(), {
        interrupt: async () => {},
        setPermissionMode: async () => {},
        setModel: async () => {},
      });
    }) as unknown as RunSessionDeps["queryImpl"];

    const seen: string[] = [];
    const running = runGovernedSession({
      session,
      prompt: "original task",
      pacer: new Pacer("realtime"),
      store,
      queryImpl,
      resume: "claude-xyz",
      onSessionId: (id) => seen.push(id),
    });
    await running.result;

    expect(capturedResume).toBe("claude-xyz");
    expect(seen).toEqual(["claude-xyz"]);
    store.close();
  });
});
