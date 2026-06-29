import { Pacer } from "@agent-jig/core";
import { SqliteStorage } from "@agent-jig/store";
import type { Client, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { runJigSession } from "../session.ts";
import { type AcpConnect, geminiAdapter } from "./gemini.ts";

const allowReject = [
  { optionId: "ok", name: "Allow", kind: "allow_once" as const },
  { optionId: "no", name: "Reject", kind: "reject_once" as const },
];

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
};

describe("geminiAdapter (via runJigSession over a fake ACP peer)", () => {
  it("gates a write through requestPermission; logs reads freely; emits reasoning + result", async () => {
    const store = new SqliteStorage(":memory:");
    const session = store.createSession({ repoPath: "/r", taskPrompt: "t" });
    const recorded: RequestPermissionResponse[] = [];

    const connect: AcpConnect = (h: Client) => ({
      async initialize() {
        return {};
      },
      async newSession() {
        return { sessionId: "g1" };
      },
      async prompt() {
        await h.sessionUpdate({
          sessionId: "g1",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "Considering the change." },
          },
        } as never);
        // A read — never raises a permission request; gated/logged via tool_call.
        await h.sessionUpdate({
          sessionId: "g1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "r1",
            title: "read a.ts",
            kind: "read",
            rawInput: { path: "a.ts" },
          },
        } as never);
        // A write — blocks on the human via requestPermission.
        const res = await h.requestPermission({
          sessionId: "g1",
          toolCall: {
            toolCallId: "w1",
            kind: "edit",
            rawInput: { file_path: "src/util/x.ts", content: "hi" },
          },
          options: allowReject,
        } as never);
        recorded.push(res);
        return { stopReason: "end_turn" };
      },
      cancel() {},
    });

    const running = runJigSession({
      session,
      prompt: "t",
      pacer: new Pacer("realtime"),
      store,
      sdk: geminiAdapter({ connect }),
    });
    await running.result;

    expect(recorded[0]).toEqual({ outcome: { outcome: "selected", optionId: "ok" } });

    const events = store.listEvents(session.id);
    const toolCalls = events.filter((e) => e.type === "tool_call");
    expect(toolCalls.map((e) => e.toolName).sort()).toEqual(["Read", "Write"]);
    const write = toolCalls.find((e) => e.toolName === "Write");
    expect((write?.payload as { file_path?: string }).file_path).toBe("src/util/x.ts");
    expect(events.some((e) => e.type === "reasoning")).toBe(true);
    expect(events.filter((e) => e.type === "tool_result")).toHaveLength(1);
    store.close();
  });

  it("rejects a write and delivers the feedback as a follow-up turn", async () => {
    const store = new SqliteStorage(":memory:");
    const session = store.createSession({ repoPath: "/r", taskPrompt: "t" });
    const pacer = new Pacer("slowed");
    const promptTexts: string[] = [];
    const recorded: RequestPermissionResponse[] = [];

    const connect: AcpConnect = (h: Client) => ({
      async initialize() {
        return {};
      },
      async newSession() {
        return { sessionId: "g1" };
      },
      async prompt(params: { prompt: Array<{ text: string }> }) {
        promptTexts.push(params.prompt[0]?.text ?? "");
        if (promptTexts.length === 1) {
          const res = await h.requestPermission({
            sessionId: "g1",
            toolCall: {
              toolCallId: "w1",
              kind: "edit",
              rawInput: { file_path: "src/x.ts", old_string: "a", new_string: "b" },
            },
            options: allowReject,
          } as never);
          recorded.push(res);
        }
        return { stopReason: "end_turn" };
      },
      cancel() {},
    });

    const running = runJigSession({
      session,
      prompt: "t",
      pacer,
      store,
      sdk: geminiAdapter({ connect }),
    });

    await waitFor(() => pacer.queue.length === 1);
    pacer.reject(pacer.queue[0]?.editId ?? "", "use the existing helper");
    await running.result;

    expect(recorded[0]).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
    expect(promptTexts).toHaveLength(2);
    expect(promptTexts[1]).toContain("use the existing helper");
    store.close();
  });

  it("interrupt cancels the active ACP session", async () => {
    let cancelledWith = "";
    const connect: AcpConnect = () => ({
      async initialize() {
        return {};
      },
      async newSession() {
        return { sessionId: "g1" };
      },
      prompt: () => new Promise(() => {}), // a turn that never finishes
      cancel({ sessionId }: { sessionId: string }) {
        cancelledWith = sessionId;
      },
    });

    const run = geminiAdapter({ connect }).run({
      prompt: "t",
      cwd: "/r",
      gate: async () => ({ allow: true, updatedInput: {} }),
    });
    const first = await run[Symbol.asyncIterator]().next();
    expect(first.value).toEqual({ type: "session", sessionId: "g1" });

    await run.interrupt();
    expect(cancelledWith).toBe("g1");
  });
});
