import { Pacer } from "@agent-jig/core";
import { SqliteStorage } from "@agent-jig/store";
import { describe, expect, it } from "vitest";
import { type ClaudeAdapterDeps, claudeAdapter } from "./claude-adapter.ts";
import { JIG_SYSTEM_PROMPT, runJigSession } from "./session.ts";

// A query() stand-in that yields a fixed message stream and then completes.
function fakeQuery(messages: unknown[]): ClaudeAdapterDeps["queryImpl"] {
  return (() => {
    async function* gen() {
      for (const m of messages) yield m;
    }
    return Object.assign(gen(), {
      interrupt: async () => {},
      setPermissionMode: async () => {},
      setModel: async () => {},
    });
  }) as unknown as ClaudeAdapterDeps["queryImpl"];
}

describe("runJigSession", () => {
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

    const running = runJigSession({
      session,
      prompt: "t",
      pacer: new Pacer("realtime"),
      store,
      sdk: claudeAdapter({ queryImpl: fakeQuery(messages) }),
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
    }) as unknown as ClaudeAdapterDeps["queryImpl"];

    const seen: string[] = [];
    const running = runJigSession({
      session,
      prompt: "original task",
      pacer: new Pacer("realtime"),
      store,
      sdk: claudeAdapter({ queryImpl }),
      resume: "claude-xyz",
      onSessionId: (id) => seen.push(id),
    });
    await running.result;

    expect(capturedResume).toBe("claude-xyz");
    expect(seen).toEqual(["claude-xyz"]);
    store.close();
  });

  it("appends Jig's backpressure guidance onto the Claude Code system prompt", async () => {
    const store = new SqliteStorage(":memory:");
    const session = store.createSession({ repoPath: "/r", taskPrompt: "t" });
    let systemPrompt: unknown;
    const queryImpl = ((args: { options?: { systemPrompt?: unknown } }) => {
      systemPrompt = args.options?.systemPrompt;
      async function* gen(): AsyncGenerator<never, void> {}
      return Object.assign(gen(), {
        interrupt: async () => {},
        setPermissionMode: async () => {},
        setModel: async () => {},
      });
    }) as unknown as ClaudeAdapterDeps["queryImpl"];

    const running = runJigSession({
      session,
      prompt: "t",
      pacer: new Pacer("realtime"),
      store,
      sdk: claudeAdapter({ queryImpl }),
    });
    await running.result;
    expect(systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: JIG_SYSTEM_PROMPT,
    });
    store.close();
  });

  it("starts in plan mode when requested", async () => {
    const store = new SqliteStorage(":memory:");
    const session = store.createSession({ repoPath: "/r", taskPrompt: "t" });
    let mode: string | undefined;
    const queryImpl = ((args: { options?: { permissionMode?: string } }) => {
      mode = args.options?.permissionMode;
      async function* gen(): AsyncGenerator<never, void> {}
      return Object.assign(gen(), {
        interrupt: async () => {},
        setPermissionMode: async () => {},
        setModel: async () => {},
      });
    }) as unknown as ClaudeAdapterDeps["queryImpl"];

    const running = runJigSession({
      session,
      prompt: "t",
      pacer: new Pacer("realtime"),
      store,
      sdk: claudeAdapter({ queryImpl }),
      planMode: true,
    });
    await running.result;
    expect(mode).toBe("plan");
    store.close();
  });
});
