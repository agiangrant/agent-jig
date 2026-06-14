import type { GovernorEvent, IntentGroup } from "@governor/contracts";
import { isWriteClass } from "./tools.ts";

/** An intent group plus the full reasoning behind it, for server-side summarization. */
export interface IntentGroupRaw extends IntentGroup {
  /** The complete agent reasoning that labels this group (untruncated). */
  reason: string;
}

/**
 * Group the session's write-class edits under the agent's stated intent. Reading
 * order = explanation order: each block of reasoning labels the edits that follow
 * it, until the next reasoning. Edits before any reasoning fall under "Other
 * changes". This replaces file order with intent order — the core of the
 * comprehension-first view. (AST collapse + outlier flagging build on top.)
 *
 * `label` is a concise heuristic gist; `reason` carries the full text so the
 * server can replace the label with a crisp LLM-generated summary.
 */
export function groupByIntent(events: readonly GovernorEvent[]): IntentGroupRaw[] {
  // Reduce to the tokens that matter: reasoning, write-class edits, and steering
  // directives. A reasoning that immediately follows a directive is the agent's
  // *reply to the steer* ("Noted — I'll keep comments minimal…"), not fresh
  // intent — flag it so it never becomes a group's label.
  type Tok =
    | { kind: "reason"; label: string; raw: string; conversational: boolean }
    | { kind: "edit"; editId: string }
    | { kind: "directive" };
  const toks: Tok[] = [];
  for (const ev of events) {
    if (ev.type === "reasoning") {
      const prev = toks[toks.length - 1];
      toks.push({
        kind: "reason",
        label: labelFrom(ev.payload),
        raw: rawText(ev.payload),
        conversational: prev?.kind === "directive",
      });
    } else if (ev.type === "directive") {
      toks.push({ kind: "directive" });
    } else if (ev.type === "tool_call" && ev.editId !== null && isWriteClass(ev.toolName ?? "")) {
      toks.push({ kind: "edit", editId: ev.editId });
    }
  }

  // Maximal runs of consecutive edits (a reasoning boundary splits them).
  interface Run {
    start: number;
    end: number;
    editIds: string[];
    label: string | null;
    reason: string;
  }
  const runs: Run[] = [];
  for (let i = 0; i < toks.length; ) {
    if (toks[i]?.kind !== "edit") {
      i++;
      continue;
    }
    const start = i;
    const editIds: string[] = [];
    for (let t = toks[i]; t?.kind === "edit"; t = toks[i]) {
      editIds.push(t.editId);
      i++;
    }
    runs.push({ start, end: i - 1, editIds, label: null, reason: "" });
  }

  // The nearest *real* reasoning in a direction, skipping directives and the
  // agent's conversational replies to them (so a steer carries the prior intent
  // forward to the redone edits). Stops at another run's edits.
  const seek = (from: number, step: 1 | -1): number | null => {
    for (let i = from; i >= 0 && i < toks.length; i += step) {
      const t = toks[i];
      if (!t || t.kind === "edit") return null;
      if (t.kind === "reason" && !t.conversational) return i;
    }
    return null;
  };

  const consumed = new Set<number>();
  const assign = (run: Run, idx: number | null) => {
    if (idx === null || consumed.has(idx)) return;
    const t = toks[idx];
    if (t?.kind !== "reason") return;
    run.label = t.label;
    run.reason = t.raw;
    consumed.add(idx);
  };

  // Prefer a leading reasoning (explain-then-edit); each labels at most one run.
  for (const run of runs) assign(run, seek(run.start - 1, -1));
  // Fall back to a trailing reasoning (edit-then-explain) for unlabeled runs.
  for (const run of runs) {
    if (run.label === null) assign(run, seek(run.end + 1, 1));
  }

  return runs.map((run) => ({
    id: run.editIds[0] ?? "",
    label: run.label ?? "Other changes",
    editIds: run.editIds,
    reason: run.reason,
  }));
}

/** A concise gist: the first sentence of the reasoning, capped with an ellipsis. */
function labelFrom(payload: unknown): string {
  const text = rawText(payload).trim();
  if (!text) return "Changes";
  const firstLine = text.split("\n")[0] ?? "";
  const firstSentence = (firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine).trim() || firstLine;
  if (firstSentence.length <= 72) return firstSentence || "Changes";
  return `${firstSentence.slice(0, 71).trimEnd()}…`;
}

function rawText(payload: unknown): string {
  return ((payload ?? {}) as { text?: string }).text ?? "";
}
