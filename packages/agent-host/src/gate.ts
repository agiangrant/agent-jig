import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { GovernorEvent } from "@governor/contracts";
import { extractPath, isWriteClass, type Pacer, scoreRisk } from "@governor/core";
import type { Storage } from "@governor/store";
import type { ProvenanceTracker } from "./provenance.ts";

export interface GateDeps {
  sessionId: string;
  pacer: Pacer;
  store: Storage;
  /** Repo cwd, used to resolve edited files and compute real line numbers. */
  cwd?: string;
  /** Fired per appended event so the server can push it to the UI. */
  onEvent?: (event: GovernorEvent) => void;
  /** Detects working-tree changes the agent's gated tools didn't make. */
  tracker?: ProvenanceTracker;
  /** Presents an `AskUserQuestion` to the human; resolves to the answer text. */
  askQuestion?: (input: Record<string, unknown>) => Promise<string>;
  /** Presents an `ExitPlanMode` plan; resolves with the human's decision. */
  reviewPlan?: (input: Record<string, unknown>) => Promise<{ approved: boolean; message?: string }>;
}

/** The agent's built-in "ask the human" tool. */
const ASK_USER_QUESTION = "AskUserQuestion";
/** The agent's built-in "I'm done planning — approve to execute?" tool. */
const EXIT_PLAN_MODE = "ExitPlanMode";

/**
 * Edit tools give us snippets, not line numbers. At gate time the file still
 * holds the OLD content, so read it and find where `old_string` starts to get a
 * real line number; enrich the logged payload with it (the UI numbers from it).
 * Returns the input unchanged if anything is missing.
 */
function withLineNumbers(
  cwd: string | undefined,
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (!cwd) return input;
  const filePath = typeof input.file_path === "string" ? input.file_path : "";
  if (!filePath) return input;
  let content: string;
  try {
    content = readFileSync(isAbsolute(filePath) ? filePath : join(cwd, filePath), "utf8");
  } catch {
    return input; // new file, or unreadable — leave default numbering
  }
  const lineOf = (needle: string): number | undefined => {
    if (!needle) return undefined;
    const idx = content.indexOf(needle);
    return idx < 0 ? undefined : content.slice(0, idx).split("\n").length;
  };
  if (toolName === "Edit" && typeof input.old_string === "string") {
    const startLine = lineOf(input.old_string);
    return startLine ? { ...input, startLine } : input;
  }
  if (toolName === "MultiEdit" && Array.isArray(input.edits)) {
    // Each edit is located in the original content (approximate for later edits).
    const startLines = (input.edits as Array<{ old_string?: string }>).map(
      (e) => lineOf(e?.old_string ?? "") ?? 1,
    );
    return { ...input, startLines };
  }
  return input;
}

/**
 * The SDK `canUseTool` callback — where backpressure is applied. Governor is the
 * permission authority (the human is in the web UI). A write-class tool in
 * `slowed` mode awaits {@link Pacer.requestGate} and genuinely blocks; everything
 * else is logged and allowed at once.
 */
export function makeCanUseTool(deps: GateDeps): CanUseTool {
  const { sessionId, pacer, store, onEvent, tracker, askQuestion, reviewPlan, cwd } = deps;
  const config = store.getConfig();

  return async (toolName, input) => {
    // Surface anything that changed the working tree since the last write
    // (Bash, the human, a formatter) before this tool's own event.
    const oob = tracker?.observe(toolName, input) ?? null;
    if (oob !== null) {
      const oobEvent = store.appendEvent({
        sessionId,
        type: "out_of_band_change",
        toolName,
        payload: oob,
      });
      onEvent?.(oobEvent);
    }

    const write = isWriteClass(toolName);
    const isQuestion = toolName === ASK_USER_QUESTION && askQuestion !== undefined;
    const isPlan = toolName === EXIT_PLAN_MODE && reviewPlan !== undefined;
    const path = extractPath(input);
    const assessment = path ? scoreRisk(path, config.riskRules, config.defaultMode) : null;
    const risk = assessment?.risk ?? null;
    const editId = write ? randomUUID() : null;
    const willGate = write && pacer.mode === "slowed";

    const call = store.appendEvent({
      sessionId,
      type: "tool_call",
      toolName,
      editId,
      risk,
      gateState: write
        ? willGate
          ? "pending"
          : "open"
        : isQuestion || isPlan
          ? "pending"
          : "open",
      payload: write ? withLineNumbers(cwd, toolName, input) : input,
    });
    onEvent?.(call);

    // ExitPlanMode: the agent finished planning. Surface the plan; approving
    // lets it execute, requesting changes denies with feedback so it revises.
    if (isPlan && reviewPlan) {
      const decision = await reviewPlan(input);
      store.setEventGateState(call.id, "open");
      onEvent?.({ ...call, gateState: "open" });
      return decision.approved
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: decision.message || "Please revise the plan." };
    }

    // AskUserQuestion: block on the human, then hand the answer back as the deny
    // message. canUseTool can't return a tool result, and *allowing* it would make
    // the headless SDK try to render a TTY prompt — the stuck state we're fixing.
    if (isQuestion && askQuestion) {
      const answer = await askQuestion(input);
      // Resolved — clear the pending marker so history doesn't show it forever
      // (re-emit the same event id; clients upsert by id).
      store.setEventGateState(call.id, "open");
      onEvent?.({ ...call, gateState: "open" });
      return { behavior: "deny", message: answer };
    }

    if (write && editId !== null) {
      const outcome = await pacer.requestGate({
        editId,
        toolName,
        path: path ?? "",
        seq: call.seq,
        risk: risk ?? 0,
      });
      // Record the resolution unless it passed straight through ('open' = realtime).
      if (outcome.state !== "open") {
        const ack = store.appendEvent({
          sessionId,
          type: "ack",
          editId,
          gateState: outcome.state,
          payload: outcome.reason ? { reason: outcome.reason } : {},
        });
        onEvent?.(ack);
      }
      // Rejected: deny the tool and hand the agent the reason so it revises.
      if (outcome.state === "rejected") {
        const message =
          outcome.reason && outcome.reason.length > 0
            ? outcome.reason
            : "The developer rejected this edit; please revise it.";
        return { behavior: "deny", message };
      }
    }

    // The SDK validates this result: `updatedInput` must be present (echo the
    // original input back), otherwise the tool is rejected with a ZodError.
    return { behavior: "allow", updatedInput: input };
  };
}
