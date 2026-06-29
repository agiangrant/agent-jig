import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import { query as realQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentMessage,
  AgentRun,
  AgentRunOptions,
  AgentSDK,
  GateDecision,
} from "./agent-sdk.ts";
import { InputStream } from "./input-stream.ts";

/** Map Jig's provider-agnostic gate decision onto the SDK's `canUseTool` result. */
function toPermissionResult(d: GateDecision) {
  return d.allow
    ? { behavior: "allow" as const, updatedInput: d.updatedInput }
    : { behavior: "deny" as const, message: d.message };
}

export interface ClaudeAdapterDeps {
  /** Injectable for tests; defaults to the real SDK `query`. */
  queryImpl?: typeof query;
}

/**
 * The Claude Agent SDK behind the {@link AgentSDK} interface. The SDK already
 * runs in-process and executes its own tools, so this adapter is thin: it owns
 * the controllable {@link InputStream}, maps the gate onto `canUseTool`, and
 * normalizes the SDK message stream into {@link AgentMessage}s. After this, it is
 * the only file (besides input-stream.ts) that imports `@anthropic-ai/claude-agent-sdk`.
 */
export function claudeAdapter(deps: ClaudeAdapterDeps = {}): AgentSDK {
  const q = deps.queryImpl ?? realQuery;
  return {
    run(opts: AgentRunOptions): AgentRun {
      const input = new InputStream();
      // The caller owns the first message: the task prompt for a fresh run, a
      // continue-nudge when resuming on restart, or the user's new instruction.
      input.push(opts.prompt);

      const runner = q({
        prompt: input,
        options: {
          cwd: opts.cwd,
          permissionMode: opts.planMode ? "plan" : "default",
          canUseTool: async (toolName, toolInput) =>
            toPermissionResult(await opts.gate(toolName, toolInput as Record<string, unknown>)),
          // Keep Claude Code's default system prompt and append Jig's guidance.
          systemPrompt: opts.appendSystemPrompt
            ? { type: "preset", preset: "claude_code", append: opts.appendSystemPrompt }
            : { type: "preset", preset: "claude_code" },
          ...(opts.resume ? { resume: opts.resume } : {}),
          ...(opts.providerOptions as Partial<Options> | undefined),
        },
      });

      let sessionSeen = false;
      async function* messages(): AsyncGenerator<AgentMessage> {
        for await (const message of runner) {
          // Capture the SDK session id once so the session can be resumed later.
          if (!sessionSeen) {
            const sid = (message as { session_id?: string }).session_id;
            if (sid) {
              sessionSeen = true;
              yield { type: "session", sessionId: sid };
            }
          }
          if (message.type === "assistant") {
            // The agent's reasoning — the raw "why" that feeds narration.
            for (const block of message.message.content) {
              if (block.type === "text" && block.text.trim().length > 0) {
                yield { type: "reasoning", text: block.text };
              }
            }
          } else if (message.type === "result") {
            yield { type: "result", raw: message };
          }
        }
      }

      const gen = messages();
      return {
        [Symbol.asyncIterator]: () => gen,
        send: (text) => input.push(text),
        end: () => input.end(),
        setPermissionMode: async (mode) =>
          runner.setPermissionMode(mode as Parameters<typeof runner.setPermissionMode>[0]),
        interrupt: async () => {
          // Preserve session.ts's historical interrupt order: end input first.
          input.end();
          await runner.interrupt();
        },
      };
    },
  };
}
