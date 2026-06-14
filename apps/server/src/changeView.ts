import type { ChangeView, GovernorEvent } from "@governor/contracts";
import { groupByIntent } from "@governor/core";
import type { EditForAnalysis, StructuralAnalyzer } from "@governor/structural";

interface EditPayload {
  file_path?: string;
  old_string?: string;
  new_string?: string;
  content?: string;
}

/**
 * The comprehension-first change view: intent groups (server-computed) enriched
 * with AST-sameness analysis. Analysis is best-effort — without an analyzer the
 * groups still render, just without collapse/outlier marks.
 */
/**
 * Events with rejected edits removed: a rejected edit was denied at the gate, so
 * it never reached disk and is not a change (reasoning/directives are kept, since
 * grouping relies on them). Shared so the view and its label enrichment group the
 * same set of edits the same way.
 */
export function visibleEvents(events: GovernorEvent[]): GovernorEvent[] {
  const rejected = new Set<string>();
  for (const e of events) {
    if (e.type === "ack" && e.gateState === "rejected" && e.editId !== null) rejected.add(e.editId);
  }
  if (rejected.size === 0) return events;
  return events.filter(
    (e) => !(e.type === "tool_call" && e.editId !== null && rejected.has(e.editId)),
  );
}

export function buildChangeView(
  events: GovernorEvent[],
  analyzer: StructuralAnalyzer | null,
): ChangeView {
  const visible = visibleEvents(events);

  const callByEditId = new Map<string, GovernorEvent>();
  for (const e of visible) {
    if (e.type === "tool_call" && e.editId !== null) callByEditId.set(e.editId, e);
  }

  return groupByIntent(visible).map((group) => {
    // `reason` is server-only (feeds label summarization); keep it off the wire.
    const base = { id: group.id, label: group.label, editIds: group.editIds };
    if (analyzer === null) {
      return { ...base, pattern: null, outliers: [] };
    }
    const edits: EditForAnalysis[] = group.editIds.map((id) => {
      const p = (callByEditId.get(id)?.payload ?? {}) as EditPayload;
      return {
        editId: id,
        path: p.file_path ?? "",
        oldString: p.old_string ?? "",
        newString: p.new_string ?? p.content ?? "",
      };
    });
    const { pattern, outliers } = analyzer.analyzeGroup(edits);
    return { ...base, pattern, outliers };
  });
}
