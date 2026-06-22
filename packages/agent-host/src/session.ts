import type { JigEvent, Session } from "@agent-jig/contracts";
import type { Pacer } from "@agent-jig/core";
import type { Storage } from "@agent-jig/store";
import type { Worktree } from "@agent-jig/worktree";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { makeCanUseTool } from "./gate.ts";
import { InputStream } from "./input-stream.ts";
import { ProvenanceTracker } from "./provenance.ts";

export interface RunSessionDeps {
  session: Session;
  prompt: string;
  pacer: Pacer;
  store: Storage;
  onEvent?: (event: JigEvent) => void;
  /** Extra SDK options merged over the defaults (model, allowedTools, ...). */
  options?: Partial<Options>;
  /** Injectable for tests; defaults to the real SDK `query`. */
  queryImpl?: typeof query;
  /** When set, flags working-tree changes the agent's gated tools didn't make. */
  worktree?: Worktree;
  /** Presents an agent `AskUserQuestion` to the human; resolves to the answer text. */
  askQuestion?: (input: Record<string, unknown>) => Promise<string>;
  /** Resume a prior SDK session (cross-process) instead of starting fresh. */
  resume?: string;
  /** Fires once with the SDK session id so it can be persisted for later resume. */
  onSessionId?: (id: string) => void;
  /** Start in plan mode — the agent plans; tools don't execute. */
  planMode?: boolean;
  /** Presents the agent's `ExitPlanMode` plan; resolves with the human's decision. */
  reviewPlan?: (input: Record<string, unknown>) => Promise<PlanDecision>;
}

/** The human's response to a plan: approve (execute) or request changes. */
export interface PlanDecision {
  approved: boolean;
  /** Feedback when not approved — handed back to the agent to revise. */
  message?: string;
}

export interface RunningSession {
  /** Resolves when the agent finishes; rejects on error. */
  result: Promise<void>;
  /** Inject a steering directive, applied at the next tool-call boundary. */
  sendDirective(text: string): void;
  /** Switch the SDK permission mode (e.g. plan → default after plan approval). */
  setPermissionMode(mode: string): Promise<void>;
  interrupt(): Promise<void>;
}

/**
 * Hosts one SDK session, gated by the Pacer. The task and any later directives
 * feed in through a controllable {@link InputStream} (Layer 3's inbound channel);
 * tools flow through {@link makeCanUseTool} into the log. The input stream is
 * auto-ended after the agent's final turn so a plain run still completes.
 */
export function runJigSession(deps: RunSessionDeps): RunningSession {
  const { session, store, onEvent } = deps;
  const tracker = deps.worktree ? new ProvenanceTracker(deps.worktree) : undefined;
  const canUseTool = makeCanUseTool({
    sessionId: session.id,
    pacer: deps.pacer,
    store,
    onEvent,
    tracker,
    askQuestion: deps.askQuestion,
    reviewPlan: deps.reviewPlan,
    cwd: session.repoPath,
  });

  const input = new InputStream();
  // The caller owns the first message: the task prompt for a fresh run, a
  // continue-nudge when resuming on restart, or the user's new instruction when
  // resuming on demand. (Streaming input acts on turns, so the first push is the
  // opening turn.)
  input.push(deps.prompt);
  // The first turn is one turn; each injected directive adds another. End the
  // input stream only once every expected turn has produced its `result`, so we
  // never close it out from under the agent while it's acting on a directive.
  let expectedResults = 1;

  const runner = (deps.queryImpl ?? query)({
    prompt: input,
    options: {
      cwd: session.repoPath,
      permissionMode: deps.planMode ? "plan" : "default",
      canUseTool,
      ...(deps.resume ? { resume: deps.resume } : {}),
      ...deps.options,
    },
  });

  const start = store.appendEvent({
    sessionId: session.id,
    type: "session_start",
    payload: { prompt: deps.prompt, resumed: Boolean(deps.resume) },
  });
  onEvent?.(start);

  let sessionIdSeen = false;

  const result = (async () => {
    try {
      for await (const message of runner) {
        // Capture the SDK session id once so the session can be resumed later.
        if (!sessionIdSeen) {
          const sid = (message as { session_id?: string }).session_id;
          if (sid) {
            sessionIdSeen = true;
            deps.onSessionId?.(sid);
          }
        }
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
    setPermissionMode: async (mode: string) => {
      await runner.setPermissionMode(mode as Parameters<typeof runner.setPermissionMode>[0]);
    },
    interrupt: async () => {
      input.end();
      await runner.interrupt();
    },
  };
}
