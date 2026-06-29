import type { JigToolCall } from "./translate.ts";

/**
 * Codex edits files through its `apply_patch` tool, but the app-server does NOT
 * put the raw V4A patch text on the wire — it parses it and emits *structured*
 * per-file changes on the `fileChange` item: each `{ path, kind, diff }` where
 * `diff` is a unified-diff string for updates and the full file content for
 * add/delete. Jig's gate and diff view speak Claude's per-file tools, so we map
 * those structured changes onto that vocabulary here. (The approval request only
 * carries the `itemId`; the changes are correlated from the item.)
 */

export type CodexChangeKind =
  | { type: "add" }
  | { type: "delete" }
  | { type: "update"; movePath?: string | null };

export interface CodexFileChange {
  path: string;
  kind: CodexChangeKind;
  /** Unified diff (update) or the full file content (add/delete). */
  diff?: string;
}

export interface DiffHunk {
  /** Context + removed lines — an Edit's `old_string`. */
  oldText: string;
  /** Context + added lines — an Edit's `new_string`. */
  newText: string;
}

/** Parse a unified-diff string into per-hunk old/new text (best-effort). */
export function parseUnifiedDiff(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let oldLines: string[] = [];
  let newLines: string[] = [];
  let inHunk = false;
  const flush = () => {
    if (oldLines.length || newLines.length) {
      hunks.push({ oldText: oldLines.join("\n"), newText: newLines.join("\n") });
      oldLines = [];
      newLines = [];
    }
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      flush(); // each hunk header starts a new hunk
      inHunk = true;
      continue;
    }
    // Skip file headers / index lines that precede the first hunk.
    if (
      line.startsWith("---") ||
      line.startsWith("+++") ||
      line.startsWith("diff ") ||
      line.startsWith("index ")
    ) {
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("-")) oldLines.push(line.slice(1));
    else if (line.startsWith("+")) newLines.push(line.slice(1));
    else {
      const text = line.startsWith(" ") ? line.slice(1) : line;
      oldLines.push(text);
      newLines.push(text);
    }
  }
  flush();
  return hunks;
}

/**
 * Map Codex's structured file changes onto Jig's tool vocabulary for the gate +
 * diff view. A single-file change renders natively (Write / Edit / MultiEdit);
 * a multi-file envelope is gated as one write-class call keyed on the first file
 * (so backpressure + risk scoring still apply), with the full structured patch
 * carried on `input.patch` for a future multi-file diff view.
 */
export function codexChangesToJig(changes: CodexFileChange[]): JigToolCall {
  const first = changes[0];
  const multiFile = changes.length > 1;

  if (first && !multiFile) {
    if (first.kind.type === "add") {
      return { toolName: "Write", input: { file_path: first.path, content: first.diff ?? "" } };
    }
    if (first.kind.type === "delete") {
      // No Jig "delete" tool — gate it as an emptying Write so it's still reviewed.
      return {
        toolName: "Write",
        input: { file_path: first.path, content: "", codexDelete: true },
      };
    }
    const hunks = first.diff ? parseUnifiedDiff(first.diff) : [];
    if (hunks.length === 1 && hunks[0]) {
      return {
        toolName: "Edit",
        input: {
          file_path: first.path,
          old_string: hunks[0].oldText,
          new_string: hunks[0].newText,
        },
      };
    }
    return {
      toolName: "MultiEdit",
      input: {
        file_path: first.path,
        edits: hunks.map((h) => ({ old_string: h.oldText, new_string: h.newText })),
      },
    };
  }

  // Multi-file (or empty) envelope: one gated approval keyed on the first path.
  return {
    toolName: "MultiEdit",
    input: {
      file_path: first?.path ?? "",
      edits: changes
        .flatMap((c) => (c.diff ? parseUnifiedDiff(c.diff) : []))
        .map((h) => ({ old_string: h.oldText, new_string: h.newText })),
      patch: changes,
    },
  };
}
