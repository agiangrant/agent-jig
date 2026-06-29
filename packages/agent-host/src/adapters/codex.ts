import { spawn } from "node:child_process";
import type { AgentMessage, AgentRun, AgentRunOptions, AgentSDK } from "../agent-sdk.ts";
import { type CodexFileChange, codexChangesToJig } from "../apply-patch.ts";
import { AsyncQueue } from "../async-queue.ts";
import { childProcessDuplex, createJsonRpcPeer, type JsonRpcPeer } from "../transport/jsonrpc.ts";

/** A connection to a `codex app-server` peer (injectable for tests). */
export type CodexConnect = (opts: AgentRunOptions) => JsonRpcPeer;

export interface CodexAdapterDeps {
  /** Headless auth: set into the child env as OPENAI_API_KEY. */
  apiKey?: string;
  /** Override the model. */
  model?: string;
  /** The CLI binary; defaults to `codex`. */
  command?: string;
  /** Injectable connection factory (tests supply a fake JSON-RPC peer). */
  connect?: CodexConnect;
}

interface ApprovalParams {
  threadId?: string;
  turnId?: string;
  itemId?: string;
  command?: string;
}
interface ThreadItem {
  id?: string;
  type?: string;
  text?: string;
  summary?: string[];
  content?: string[];
  command?: string;
  changes?: CodexFileChange[];
}
interface ItemParams {
  item?: ThreadItem;
  itemId?: string;
  changes?: CodexFileChange[];
}
interface TurnParams {
  turn?: { id?: string; status?: string };
  error?: { message?: string };
  message?: string;
}

/** Spawn `codex app-server` and wrap its stdio in a JSON-RPC peer. */
function spawnConnect(deps: CodexAdapterDeps): CodexConnect {
  return (opts) => {
    const child = spawn(deps.command ?? "codex", ["app-server"], {
      cwd: opts.cwd,
      env: deps.apiKey ? { ...process.env, OPENAI_API_KEY: deps.apiKey } : process.env,
    });
    // Surface the CLI's auth/errors in the server log.
    child.stderr.pipe(process.stderr);
    return createJsonRpcPeer(childProcessDuplex(child));
  };
}

/**
 * The Codex CLI behind the {@link AgentSDK} interface, over `codex app-server`'s
 * JSON-RPC protocol. Jig's gate is wired to Codex's server→client approval
 * requests: a `fileChange` approval blocks until the human acks; command
 * approvals (and commands that don't need approval) are logged but pass freely
 * ("backpressure on writes, not on thought"). The patch isn't inlined on the
 * approval — its structured changes are correlated from the `fileChange` item
 * and translated into Jig's vocabulary ({@link codexChangesToJig}).
 */
export function codexAdapter(deps: CodexAdapterDeps = {}): AgentSDK {
  const connect = deps.connect ?? spawnConnect(deps);
  return {
    run(opts: AgentRunOptions): AgentRun {
      const out = new AsyncQueue<AgentMessage>();
      const prompts = new AsyncQueue<string>();
      prompts.push(opts.prompt);
      const changesByItem = new Map<string, CodexFileChange[]>();
      const gatedItems = new Set<string>();
      let threadId = "";
      let currentTurnId = "";
      let resolveTurn: ((turn: TurnParams["turn"]) => void) | null = null;
      let driverError: unknown;

      const conn = connect(opts);

      const fail = (message: string, turn?: TurnParams["turn"]) => {
        driverError = new Error(message);
        prompts.end();
        resolveTurn?.(turn);
        resolveTurn = null;
      };

      // Approval gate: a file change blocks on the human.
      conn.onRequest("item/fileChange/requestApproval", async (raw) => {
        const p = raw as ApprovalParams;
        if (p.itemId) gatedItems.add(p.itemId);
        const changes = (p.itemId && changesByItem.get(p.itemId)) || [];
        const { toolName, input } = codexChangesToJig(changes);
        const decision = await opts.gate(toolName, input);
        if (decision.allow) return { decision: "accept" };
        // `decline` lets the turn continue; deliver the reason via turn/steer
        // (Codex's decline carries no message — the documented non-atomic gap).
        if (decision.message.trim()) {
          conn
            .request("turn/steer", {
              threadId,
              input: [
                {
                  type: "text",
                  text: `Regarding the edit you just attempted, which was rejected: ${decision.message}`,
                },
              ],
              expectedTurnId: p.turnId,
            })
            .catch(() => {});
        }
        return { decision: "decline" };
      });

      // Command approvals: Bash isn't write-class, so the gate logs and allows it.
      conn.onRequest("item/commandExecution/requestApproval", async (raw) => {
        const p = raw as ApprovalParams;
        if (p.itemId) gatedItems.add(p.itemId);
        const decision = await opts.gate("Bash", { command: p.command ?? "" });
        return { decision: decision.allow ? "accept" : "decline" };
      });

      const cacheChanges = (item?: ThreadItem) => {
        if (item?.type === "fileChange" && item.id && Array.isArray(item.changes)) {
          changesByItem.set(item.id, item.changes);
        }
      };
      conn.onNotification("item/started", (raw) => cacheChanges((raw as ItemParams).item));
      conn.onNotification("item/fileChange/patchUpdated", (raw) => {
        const p = raw as ItemParams;
        if (p.itemId && Array.isArray(p.changes)) changesByItem.set(p.itemId, p.changes);
      });
      conn.onNotification("item/completed", (raw) => {
        const item = (raw as ItemParams).item;
        if (!item) return;
        if (item.type === "agentMessage" && item.text?.trim()) {
          out.push({ type: "reasoning", text: item.text });
        } else if (item.type === "reasoning") {
          const text = [...(item.summary ?? []), ...(item.content ?? [])].join("\n").trim();
          if (text) out.push({ type: "reasoning", text });
        } else if (item.type === "commandExecution" && item.id && !gatedItems.has(item.id)) {
          // A command that ran without needing approval — log it as Bash.
          gatedItems.add(item.id);
          void opts.gate("Bash", { command: item.command ?? "" });
        } else if (item.type === "fileChange") {
          cacheChanges(item);
        }
      });
      conn.onNotification("turn/completed", (raw) => {
        resolveTurn?.((raw as TurnParams).turn);
        resolveTurn = null;
      });
      conn.onNotification("turn/failed", (raw) => {
        const p = raw as TurnParams;
        fail(p.error?.message ?? "turn failed", p.turn);
      });
      conn.onNotification("error", (raw) => {
        fail((raw as TurnParams).message ?? "codex error");
      });

      const driver = (async () => {
        try {
          await conn.request("initialize", {
            clientInfo: { name: "jig", version: "0.1.0" },
            capabilities: {},
          });
          conn.notify("initialized", {});
          const started = (await conn.request("thread/start", {
            cwd: opts.cwd,
            ...(deps.model ? { model: deps.model } : {}),
            approvalPolicy: "on-request",
            sandbox: opts.planMode ? "read-only" : "workspace-write",
          })) as { thread?: { id?: string } };
          threadId = started.thread?.id ?? "";
          out.push({ type: "session", sessionId: threadId });

          for await (const text of prompts) {
            const done = new Promise<TurnParams["turn"]>((resolve) => {
              resolveTurn = resolve;
            });
            const ts = (await conn.request("turn/start", {
              threadId,
              input: [{ type: "text", text }],
            })) as { turn?: { id?: string } };
            currentTurnId = ts.turn?.id ?? "";
            const turn = await done;
            out.push({ type: "result", raw: turn ?? { status: "completed" } });
          }
        } catch (err) {
          driverError = err;
        } finally {
          conn.close();
          out.end();
        }
      })();
      void driver;

      async function* iterate(): AsyncGenerator<AgentMessage> {
        for await (const message of out) yield message;
        if (driverError) throw driverError;
      }
      const gen = iterate();

      return {
        [Symbol.asyncIterator]: () => gen,
        send: (text) => prompts.push(text),
        end: () => prompts.end(),
        interrupt: async () => {
          prompts.end();
          if (threadId && currentTurnId) {
            await conn
              .request("turn/interrupt", { threadId, turnId: currentTurnId })
              .catch(() => {});
          }
        },
      };
    },
  };
}
