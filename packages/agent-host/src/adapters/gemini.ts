import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { isWriteClass } from "@agent-jig/core";
import {
  type Client,
  ClientSideConnection,
  type NewSessionResponse,
  ndJsonStream,
  type PermissionOption,
  type PermissionOptionKind,
  PROTOCOL_VERSION,
  type PromptResponse,
  type RequestPermissionResponse,
  type SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import type { AgentMessage, AgentRun, AgentRunOptions, AgentSDK } from "../agent-sdk.ts";
import { AsyncQueue } from "../async-queue.ts";
import { geminiToolToJig } from "../translate.ts";

/**
 * The subset of an ACP agent connection the Gemini adapter drives. The real
 * connection is {@link ClientSideConnection} (it structurally satisfies this);
 * tests inject a fake that plays "Gemini" by calling back into the {@link Client}
 * handlers. `dispose` tears down the child process.
 */
export interface AcpConn {
  initialize(params: { protocolVersion: number; clientCapabilities?: unknown }): Promise<unknown>;
  newSession(params: { cwd: string; mcpServers: unknown[] }): Promise<NewSessionResponse>;
  prompt(params: {
    sessionId: string;
    prompt: Array<{ type: "text"; text: string }>;
  }): Promise<PromptResponse>;
  cancel(params: { sessionId: string }): Promise<void> | void;
  setSessionMode?(params: { sessionId: string; modeId: string }): Promise<SetSessionModeResponse>;
  dispose?(): void;
}

export type AcpConnect = (handlers: Client, opts: AgentRunOptions) => AcpConn;

export interface GeminiAdapterDeps {
  /** Headless auth: set into the child env as GEMINI_API_KEY. */
  apiKey?: string;
  /** Override the model (passed as `-m <model>`). */
  model?: string;
  /** The CLI binary; defaults to `gemini`. */
  command?: string;
  /** Injectable connection factory (tests supply a fake ACP peer). */
  connect?: AcpConnect;
}

/** Pick the option matching the first available kind (agents define their own ids). */
function pickOption(
  options: readonly PermissionOption[],
  kinds: PermissionOptionKind[],
): PermissionOption | undefined {
  for (const kind of kinds) {
    const found = options.find((o) => o.kind === kind);
    if (found) return found;
  }
  return undefined;
}

/** Spawn `gemini --acp` and wrap it in a {@link ClientSideConnection}. */
function spawnConnect(deps: GeminiAdapterDeps): AcpConnect {
  return (handlers, opts) => {
    const args = ["--acp", ...(deps.model ? ["-m", deps.model] : [])];
    const child = spawn(deps.command ?? "gemini", args, {
      cwd: opts.cwd,
      env: deps.apiKey ? { ...process.env, GEMINI_API_KEY: deps.apiKey } : process.env,
      // stderr inherits so the CLI's auth/errors surface in the server log.
      stdio: ["pipe", "pipe", "inherit"],
    });
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const conn = new ClientSideConnection(() => handlers, stream);
    return Object.assign(conn as unknown as AcpConn, { dispose: () => child.kill() });
  };
}

/**
 * The Gemini CLI behind the {@link AgentSDK} interface, over the Agent Client
 * Protocol (`gemini --acp`). Jig's gate is wired to ACP's per-tool
 * `requestPermission` handshake: a write-class tool blocks there until the human
 * acks; reads/searches never raise a permission request and are logged via the
 * `tool_call` session update ("backpressure on writes, not on thought"). Tool
 * calls are translated into Jig's vocabulary first ({@link geminiToolToJig}) so
 * the gate, diff view, and narration stay unchanged.
 */
export function geminiAdapter(deps: GeminiAdapterDeps = {}): AgentSDK {
  const connect = deps.connect ?? spawnConnect(deps);
  return {
    run(opts: AgentRunOptions): AgentRun {
      const out = new AsyncQueue<AgentMessage>();
      const prompts = new AsyncQueue<string>();
      prompts.push(opts.prompt);
      // Tool calls already sent through the gate, so we don't double-log a tool
      // that surfaces both a `tool_call` update and a `requestPermission`.
      const gated = new Set<string>();
      let sessionId = "";
      let driverError: unknown;

      const handlers: Client = {
        async requestPermission({ toolCall, options }): Promise<RequestPermissionResponse> {
          gated.add(toolCall.toolCallId);
          const { toolName, input } = geminiToolToJig(toolCall);
          const decision = await opts.gate(toolName, input);
          if (decision.allow) {
            const opt = pickOption(options, ["allow_once", "allow_always"]);
            return opt
              ? { outcome: { outcome: "selected", optionId: opt.optionId } }
              : { outcome: { outcome: "cancelled" } };
          }
          // ACP `reject` carries no message, so deny-with-feedback is non-atomic:
          // reject the call, then deliver the reason as a follow-up steering turn.
          if (decision.message.trim()) {
            prompts.push(
              `Regarding the edit you just attempted, which was rejected: ${decision.message}`,
            );
          }
          const opt = pickOption(options, ["reject_once", "reject_always"]);
          return opt
            ? { outcome: { outcome: "selected", optionId: opt.optionId } }
            : { outcome: { outcome: "cancelled" } };
        },
        sessionUpdate({ update }) {
          if (
            update.sessionUpdate === "agent_message_chunk" ||
            update.sessionUpdate === "agent_thought_chunk"
          ) {
            const c = update.content;
            if (c.type === "text" && c.text.trim().length > 0) {
              out.push({ type: "reasoning", text: c.text });
            }
          } else if (update.sessionUpdate === "tool_call") {
            // Reads/searches don't request permission — gate them here so they're
            // logged (the gate returns allow at once for non-write tools).
            const { toolName, input } = geminiToolToJig(update);
            if (!isWriteClass(toolName) && !gated.has(update.toolCallId)) {
              gated.add(update.toolCallId);
              void opts.gate(toolName, input);
            }
          }
        },
      };

      const conn = connect(handlers, opts);

      const driver = (async () => {
        try {
          await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
          const session = await conn.newSession({ cwd: opts.cwd, mcpServers: [] });
          sessionId = session.sessionId;
          out.push({ type: "session", sessionId });
          if (opts.planMode) {
            await conn.setSessionMode?.({ sessionId, modeId: "plan" }).catch(() => {});
          }
          // One ACP prompt per turn: the task, then each steering directive.
          for await (const text of prompts) {
            const res = await conn.prompt({
              sessionId,
              prompt: [{ type: "text", text }],
            });
            out.push({ type: "result", raw: res });
          }
        } catch (err) {
          driverError = err;
        } finally {
          conn.dispose?.();
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
        setPermissionMode: async (mode) => {
          if (sessionId) await conn.setSessionMode?.({ sessionId, modeId: mode }).catch(() => {});
        },
        interrupt: async () => {
          prompts.end();
          if (sessionId) await conn.cancel({ sessionId });
        },
      };
    },
  };
}
