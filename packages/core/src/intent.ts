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
  // Reduce to the only tokens that matter: reasoning, and write-class edits.
  type Tok = { kind: "reason"; label: string; raw: string } | { kind: "edit"; editId: string };
  const toks: Tok[] = [];
  for (const ev of events) {
    if (ev.type === "reasoning") {
      toks.push({ kind: "reason", label: labelFrom(ev.payload), raw: rawText(ev.payload) });
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

  const consumed = new Set<number>();
  const reasonAt = (idx: number): { label: string; raw: string } | null => {
    const t = toks[idx];
    return t?.kind === "reason" ? t : null;
  };

  // Prefer a leading reasoning (explain-then-edit); each labels at most one run.
  for (const run of runs) {
    const lead = run.start - 1;
    const t = reasonAt(lead);
    if (t !== null && !consumed.has(lead)) {
      run.label = t.label;
      run.reason = t.raw;
      consumed.add(lead);
    }
  }
  // Fall back to a trailing reasoning (edit-then-explain) for unlabeled runs.
  for (const run of runs) {
    if (run.label !== null) continue;
    const trail = run.end + 1;
    const t = reasonAt(trail);
    if (t !== null && !consumed.has(trail)) {
      run.label = t.label;
      run.reason = t.raw;
      consumed.add(trail);
    }
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
