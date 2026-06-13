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
export function buildChangeView(
  events: GovernorEvent[],
  analyzer: StructuralAnalyzer | null,
): ChangeView {
  const callByEditId = new Map<string, GovernorEvent>();
  for (const e of events) {
    if (e.type === "tool_call" && e.editId !== null) callByEditId.set(e.editId, e);
  }

  return groupByIntent(events).map((group) => {
    if (analyzer === null) {
      return { ...group, pattern: null, outliers: [] };
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
    return { ...group, pattern, outliers };
  });
}
