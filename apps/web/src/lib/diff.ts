// Turn a write-class tool's input into before/after hunks for a plain diff.
// Phase 1 shows the literal before/after; structural/intent grouping is Phase 2.

export interface Hunk {
  old: string[];
  new: string[];
  /** 1-based starting line of this hunk in the file (1 if unknown). */
  startLine: number;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function lineNo(v: unknown): number {
  return typeof v === "number" && v > 0 ? v : 1;
}

export function toHunks(toolName: string, payload: unknown): Hunk[] {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;

  if (toolName === "Write") {
    return [{ old: [], new: str(p.content).split("\n"), startLine: 1 }];
  }
  if (toolName === "Edit") {
    return [
      {
        old: str(p.old_string).split("\n"),
        new: str(p.new_string).split("\n"),
        startLine: lineNo(p.startLine),
      },
    ];
  }
  if (toolName === "MultiEdit" && Array.isArray(p.edits)) {
    const starts = Array.isArray(p.startLines) ? (p.startLines as unknown[]) : [];
    return (p.edits as unknown[]).map((e, i) => {
      const ed = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
      return {
        old: str(ed.old_string).split("\n"),
        new: str(ed.new_string).split("\n"),
        startLine: lineNo(starts[i]),
      };
    });
  }
  return [];
}
