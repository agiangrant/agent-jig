import type { JigEvent, Session } from "@agent-jig/contracts";
import type { Pacer } from "@agent-jig/core";
import type { Storage } from "@agent-jig/store";
import type { Worktree } from "@agent-jig/worktree";
import type { AgentSDK } from "./agent-sdk.ts";
import { claudeAdapter } from "./claude-adapter.ts";
import { makeGate } from "./gate.ts";
import { ProvenanceTracker } from "./provenance.ts";

export interface RunSessionDeps {
  session: Session;
  prompt: string;
  pacer: Pacer;
  store: Storage;
  onEvent?: (event: JigEvent) => void;
  /** Extra provider-specific options merged over the defaults (model, allowedTools, ...). */
  options?: Record<string, unknown>;
  /** The agent runtime; defaults to a real Claude adapter. Injectable for tests. */
  sdk?: AgentSDK;
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

/**
 * Appended to the agent's Claude Code system prompt on every Jig session. Jig's
 * whole value is the human-paced review loop on *writes*: Edit/Write/MultiEdit go
 * through a gate that pauses each one for a diff + approval. Bash is deliberately
 * NOT gated (backpressure on writes, not on thought), so a file change made
 * through the shell lands silently and bypasses review — which defeats the tool.
 * This steers the agent to keep writes in the gated tools, and to *surface* the
 * rare shell-write that's genuinely better instead of running it unannounced.
 */
export const JIG_SYSTEM_PROMPT = `You are running inside Jig, a supervised-coding tool. A human reviews and paces your file edits: writes made with the Edit, Write, and MultiEdit tools are gated — each one pauses for the human to see a diff and approve it. That review loop is the entire point of Jig.

Bash commands are NOT gated, so a file change made through the shell lands silently and bypasses review. That defeats Jig's purpose. Follow these rules:

- Never use Bash to create, modify, move, or delete files (\`>\`/\`>>\` redirects, \`sed -i\`, \`mv\`, \`rm\`, \`cp\`, \`tee\`, \`patch\`, \`git apply\`, heredocs into files, etc.) when the Edit, Write, or MultiEdit tools can do the same job. Reach for those gated tools by default.
- Bash is for reading, searching, building, testing, installing, and running commands that do not write source files — those flow freely.
- A few write tasks are genuinely better as a shell command: a project-wide symbol rename, a codemod, or a large mechanical move across many files. When that is truly the case, do NOT run it silently — first state in plain text what the command will change and why the shell is the better tool, then run it. A clear announcement is enough; you do not need to stop and ask for approval, since the human can see your message and steer if needed.`;

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
  const gate = makeGate({
    sessionId: session.id,
    pacer: deps.pacer,
    store,
    onEvent,
    tracker,
    askQuestion: deps.askQuestion,
    reviewPlan: deps.reviewPlan,
    cwd: session.repoPath,
  });

  // The first turn is one turn; each injected directive adds another. End the
  // input stream only once every expected turn has produced its `result`, so we
  // never close it out from under the agent while it's acting on a directive.
  let expectedResults = 1;

  const sdk = deps.sdk ?? claudeAdapter();
  const run = sdk.run({
    prompt: deps.prompt,
    cwd: session.repoPath,
    gate,
    planMode: deps.planMode,
    appendSystemPrompt: JIG_SYSTEM_PROMPT,
    resume: deps.resume,
    providerOptions: deps.options,
  });

  const start = store.appendEvent({
    sessionId: session.id,
    type: "session_start",
    payload: { prompt: deps.prompt, resumed: Boolean(deps.resume) },
  });
  onEvent?.(start);

  const result = (async () => {
    try {
      for await (const message of run) {
        if (message.type === "session") {
          // The provider's resumable session id — persist it for later resume.
          deps.onSessionId?.(message.sessionId);
        } else if (message.type === "reasoning") {
          // The agent's reasoning — the raw "why" that feeds narration.
          const event = store.appendEvent({
            sessionId: session.id,
            type: "reasoning",
            payload: { text: message.text },
          });
          onEvent?.(event);
        } else if (message.type === "result") {
          store.appendEvent({ sessionId: session.id, type: "tool_result", payload: message.raw });
          expectedResults -= 1;
          if (expectedResults <= 0) run.end();
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
      run.send(text);
    },
    setPermissionMode: async (mode: string) => {
      await run.setPermissionMode?.(mode);
    },
    interrupt: async () => {
      await run.interrupt();
    },
  };
}
