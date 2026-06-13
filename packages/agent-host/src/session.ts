import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { GovernorEvent, Session } from "@governor/contracts";
import type { Pacer } from "@governor/core";
import type { Storage } from "@governor/store";
import { makeCanUseTool } from "./gate.ts";

export interface RunSessionDeps {
  session: Session;
  prompt: string;
  pacer: Pacer;
  store: Storage;
  onEvent?: (event: GovernorEvent) => void;
  /** Extra SDK options merged over the defaults (model, allowedTools, ...). */
  options?: Partial<Options>;
  /** Injectable for tests; defaults to the real SDK `query`. */
  queryImpl?: typeof query;
}

export interface RunningSession {
  /** Resolves when the agent finishes; rejects on error. */
  result: Promise<void>;
  interrupt(): Promise<void>;
}

/**
 * Hosts one SDK session, gated by the Pacer. Tools flow through
 * {@link makeCanUseTool} into the log; the message iterator drives execution.
 * Phase 3 will swap the string `prompt` for a controllable AsyncIterable to
 * inject directives mid-session.
 */
export function runGovernedSession(deps: RunSessionDeps): RunningSession {
  const { session, store, onEvent } = deps;
  const canUseTool = makeCanUseTool({
    sessionId: session.id,
    pacer: deps.pacer,
    store,
    onEvent,
  });

  const runner = (deps.queryImpl ?? query)({
    prompt: deps.prompt,
    options: {
      cwd: session.repoPath,
      permissionMode: "default",
      canUseTool,
      ...deps.options,
    },
  });

  const start = store.appendEvent({
    sessionId: session.id,
    type: "session_start",
    payload: { prompt: deps.prompt },
  });
  onEvent?.(start);

  const result = (async () => {
    try {
      for await (const message of runner) {
        // Phase 2 will mine assistant messages here for narration.
        if (message.type === "result") {
          store.appendEvent({ sessionId: session.id, type: "tool_result", payload: message });
        }
      }
      store.setSessionStatus(session.id, "done", Date.now());
    } catch (error) {
      store.setSessionStatus(session.id, "error", Date.now());
      throw error;
    } finally {
      const end = store.appendEvent({ sessionId: session.id, type: "session_end", payload: {} });
      onEvent?.(end);
    }
  })();

  return { result, interrupt: () => runner.interrupt() };
}
