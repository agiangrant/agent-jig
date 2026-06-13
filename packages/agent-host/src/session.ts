import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { GovernorEvent, Session } from "@governor/contracts";
import type { Pacer } from "@governor/core";
import type { Storage } from "@governor/store";
import type { Worktree } from "@governor/worktree";
import { makeCanUseTool } from "./gate.ts";
import { InputStream } from "./input-stream.ts";
import { ProvenanceTracker } from "./provenance.ts";

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
  /** When set, flags working-tree changes the agent's gated tools didn't make. */
  worktree?: Worktree;
}

export interface RunningSession {
  /** Resolves when the agent finishes; rejects on error. */
  result: Promise<void>;
  /** Inject a steering directive, applied at the next tool-call boundary. */
  sendDirective(text: string): void;
  interrupt(): Promise<void>;
}

/**
 * Hosts one SDK session, gated by the Pacer. The task and any later directives
 * feed in through a controllable {@link InputStream} (Layer 3's inbound channel);
 * tools flow through {@link makeCanUseTool} into the log. The input stream is
 * auto-ended after the agent's final turn so a plain run still completes.
 */
export function runGovernedSession(deps: RunSessionDeps): RunningSession {
  const { session, store, onEvent } = deps;
  const tracker = deps.worktree ? new ProvenanceTracker(deps.worktree) : undefined;
  const canUseTool = makeCanUseTool({
    sessionId: session.id,
    pacer: deps.pacer,
    store,
    onEvent,
    tracker,
  });

  const input = new InputStream();
  input.push(deps.prompt); // the initial task
  // The initial task is one turn; each injected directive adds another. End the
  // input stream only once every expected turn has produced its `result`, so we
  // never close it out from under the agent while it's acting on a directive.
  let expectedResults = 1;

  const runner = (deps.queryImpl ?? query)({
    prompt: input,
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
        if (message.type === "assistant") {
          // Capture the agent's reasoning — the raw "why" that feeds narration.
          for (const block of message.message.content) {
            if (block.type === "text" && block.text.trim().length > 0) {
              const event = store.appendEvent({
                sessionId: session.id,
                type: "reasoning",
                payload: { text: block.text },
              });
              onEvent?.(event);
            }
          }
        } else if (message.type === "result") {
          store.appendEvent({ sessionId: session.id, type: "tool_result", payload: message });
          expectedResults -= 1;
          if (expectedResults <= 0) input.end();
        }
      }
      const oob = tracker?.finalize();
      if (oob) {
        const event = store.appendEvent({
          sessionId: session.id,
          type: "out_of_band_change",
          payload: oob,
        });
        onEvent?.(event);
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

  return {
    result,
    sendDirective: (text: string) => {
      expectedResults += 1;
      input.push(text);
    },
    interrupt: async () => {
      input.end();
      await runner.interrupt();
    },
  };
}
