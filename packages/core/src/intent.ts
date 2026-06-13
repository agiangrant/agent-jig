import type { GovernorEvent, IntentGroup } from "@governor/contracts";
import { isWriteClass } from "./tools.ts";

/**
 * Group the session's write-class edits under the agent's stated intent. Reading
 * order = explanation order: each block of reasoning labels the edits that follow
 * it, until the next reasoning. Edits before any reasoning fall under "Other
 * changes". This replaces file order with intent order — the core of the
 * comprehension-first view. (AST collapse + outlier flagging build on top.)
 */
export function groupByIntent(events: readonly GovernorEvent[]): IntentGroup[] {
  // Reduce to the only tokens that matter: reasoning, and write-class edits.
  const toks: Array<{ kind: "reason"; label: string } | { kind: "edit"; editId: string }> = [];
  for (const ev of events) {
    if (ev.type === "reasoning") {
      toks.push({ kind: "reason", label: labelFrom(ev.payload) });
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
    runs.push({ start, end: i - 1, editIds, label: null });
  }

  const consumed = new Set<number>();
  const reasonAt = (idx: number): string | null => {
    const t = toks[idx];
    return t?.kind === "reason" ? t.label : null;
  };

  // Prefer a leading reasoning (explain-then-edit); each labels at most one run.
  for (const run of runs) {
    const lead = run.start - 1;
    const label = reasonAt(lead);
    if (label !== null && !consumed.has(lead)) {
      run.label = label;
      consumed.add(lead);
    }
  }
  // Fall back to a trailing reasoning (edit-then-explain) for unlabeled runs.
  for (const run of runs) {
    if (run.label !== null) continue;
    const trail = run.end + 1;
    const label = reasonAt(trail);
    if (label !== null && !consumed.has(trail)) {
      run.label = label;
      consumed.add(trail);
    }
  }

  return runs.map((run) => ({
    id: run.editIds[0] ?? "",
    label: run.label ?? "Other changes",
    editIds: run.editIds,
  }));
}

/** First line of the reasoning, capped — the group's thesis. */
function labelFrom(payload: unknown): string {
  const text = ((payload ?? {}) as { text?: string }).text ?? "";
  const firstLine = text.trim().split("\n")[0] ?? "";
  return firstLine.slice(0, 140) || "Changes";
}
