import { Pacer } from "@agent-jig/core";
import { SqliteStorage } from "@agent-jig/store";
import { describe, expect, it } from "vitest";
import { runJigSession } from "../session.ts";
import type { JsonRpcPeer } from "../transport/jsonrpc.ts";
import { type CodexConnect, codexAdapter } from "./codex.ts";

type Handler = (params: unknown) => unknown;

/** A fake `codex app-server` peer: canned responses + script-driven turns. */
function fakeCodex(onTurn?: (turnNo: number, api: FakeApi) => void) {
  const sent: Array<{ method: string; params: unknown }> = [];
  const reqHandlers = new Map<string, Handler>();
  const notifHandlers = new Map<string, Handler>();
  let turnNo = 0;

  const api: FakeApi = {
    sent,
    emit: (method, params) => notifHandlers.get(method)?.(params),
    approve: async (method, params) => reqHandlers.get(method)?.(params),
  };

  const peer: JsonRpcPeer = {
    async request(method, params) {
      sent.push({ method, params });
      if (method === "thread/start") return { thread: { id: "c1" } } as never;
      if (method === "turn/start") {
        const n = ++turnNo;
        // Drive the turn after the caller records currentTurnId (macrotask).
        if (onTurn) setTimeout(() => onTurn(n, api), 0);
        return { turn: { id: `t${n}` } } as never;
      }
      return {} as never;
    },
    notify: (method, params) => sent.push({ method, params }),
    onRequest: (method, handler) => reqHandlers.set(method, handler),
    onNotification: (method, handler) => notifHandlers.set(method, handler),
    close: () => {},
  };
  return { connect: (() => peer) as CodexConnect, api };
}

interface FakeApi {
  sent: Array<{ method: string; params: unknown }>;
  emit: (method: string, params: unknown) => void;
  approve: (method: string, params: unknown) => Promise<unknown>;
}

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
};

describe("codexAdapter (via runJigSession over a fake app-server)", () => {
  it("gates a file change; logs a command; emits reasoning + result", async () => {
    const store = new SqliteStorage(":memory:");
    const session = store.createSession({ repoPath: "/r", taskPrompt: "t" });
    const recorded: unknown[] = [];

    const { connect } = fakeCodex(async (turnNo, api) => {
      api.emit("item/started", {
        item: {
          id: "i1",
          type: "fileChange",
          changes: [
            { path: "src/util/x.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-a\n+b" },
          ],
          status: "in_progress",
        },
      });
      api.emit("item/completed", {
        item: { id: "r1", type: "reasoning", summary: ["Thinking"], content: ["about the change"] },
      });
      recorded.push(
        await api.approve("item/fileChange/requestApproval", {
          threadId: "c1",
          turnId: `t${turnNo}`,
          itemId: "i1",
          startedAtMs: 0,
        }),
      );
      api.emit("item/completed", {
        item: { id: "cmd1", type: "commandExecution", command: "ls -la", status: "completed" },
      });
      api.emit("item/completed", { item: { id: "a1", type: "agentMessage", text: "Done." } });
      api.emit("turn/completed", {
        threadId: "c1",
        turn: { id: `t${turnNo}`, status: "completed" },
      });
    });

    const running = runJigSession({
      session,
      prompt: "t",
      pacer: new Pacer("realtime"),
      store,
      sdk: codexAdapter({ connect }),
    });
    await running.result;

    expect(recorded[0]).toEqual({ decision: "accept" });

    const events = store.listEvents(session.id);
    const toolCalls = events.filter((e) => e.type === "tool_call");
    expect(toolCalls.map((e) => e.toolName).sort()).toEqual(["Bash", "Edit"]);
    const edit = toolCalls.find((e) => e.toolName === "Edit");
    expect((edit?.payload as { file_path?: string; new_string?: string }).file_path).toBe(
      "src/util/x.ts",
    );
    expect((edit?.payload as { new_string?: string }).new_string).toBe("b");
    expect(events.some((e) => e.type === "reasoning")).toBe(true);
    expect(events.filter((e) => e.type === "tool_result")).toHaveLength(1);
    store.close();
  });

  it("declines a rejected change and steers the feedback into the turn", async () => {
    const store = new SqliteStorage(":memory:");
    const session = store.createSession({ repoPath: "/r", taskPrompt: "t" });
    const pacer = new Pacer("slowed");
    const recorded: unknown[] = [];

    const { connect, api } = fakeCodex(async (turnNo, a) => {
      a.emit("item/started", {
        item: {
          id: "i1",
          type: "fileChange",
          changes: [{ path: "src/x.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-a\n+b" }],
          status: "in_progress",
        },
      });
      recorded.push(
        await a.approve("item/fileChange/requestApproval", {
          threadId: "c1",
          turnId: `t${turnNo}`,
          itemId: "i1",
          startedAtMs: 0,
        }),
      );
      a.emit("turn/completed", { threadId: "c1", turn: { id: `t${turnNo}`, status: "completed" } });
    });

    const running = runJigSession({
      session,
      prompt: "t",
      pacer,
      store,
      sdk: codexAdapter({ connect }),
    });

    await waitFor(() => pacer.queue.length === 1);
    pacer.reject(pacer.queue[0]?.editId ?? "", "use the existing helper");
    await running.result;

    expect(recorded[0]).toEqual({ decision: "decline" });
    const steer = api.sent.find((s) => s.method === "turn/steer");
    expect(steer).toBeDefined();
    expect(JSON.stringify(steer?.params)).toContain("use the existing helper");
    store.close();
  });

  it("interrupt cancels the active turn", async () => {
    const { connect, api } = fakeCodex(); // no onTurn → the turn never completes
    const run = codexAdapter({ connect }).run({
      prompt: "t",
      cwd: "/r",
      gate: async () => ({ allow: true, updatedInput: {} }),
    });
    const first = await run[Symbol.asyncIterator]().next();
    expect(first.value).toEqual({ type: "session", sessionId: "c1" });

    await waitFor(() => api.sent.some((s) => s.method === "turn/start"));
    await run.interrupt();

    const interrupt = api.sent.find((s) => s.method === "turn/interrupt");
    expect(interrupt?.params).toEqual({ threadId: "c1", turnId: "t1" });
  });
});
