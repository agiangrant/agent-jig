// Row-model for the Review tab's full-context diff. Given an edit's hunks (old/new
// snippets + 1-based start line) plus whatever surrounding lines have been fetched
// from the worktree, build an ordered row list for unified and split rendering.
//
// Two things make this faithful rather than a naive block diff:
//  1. A line-level LCS *within* each hunk, so lines the agent re-emitted unchanged
//     show as context — not as a delete immediately followed by an identical add.
//  2. A word-level diff on each modified line, so the row carries `emph` ranges:
//     the line gets a faded tint and only the characters that changed are strong.
//
// Unchanged regions we haven't fetched collapse to a single "fold" row sized from
// the file's total line count, so the UI can fetch that range on demand.

import { type Hunk, toHunks } from "./diff.ts";

export type LineType = "ctx" | "add" | "del";

/** Inclusive-exclusive char range within a line that actually changed. */
export type Range = [number, number];

export interface DiffLine {
  kind: "line";
  type: LineType;
  /** Old-file line number (null for an inserted line). */
  oldNo: number | null;
  /** New-file line number (null for a deleted line). */
  newNo: number | null;
  text: string;
  /** Set on the first row of each change run, for prev/next-change navigation. */
  hunk?: number;
  /** Changed char ranges (modified lines only); absent = the whole line changed. */
  emph?: Range[];
}

export interface DiffFold {
  kind: "fold";
  /** Old-file line range (inclusive) hidden behind this fold. */
  from: number;
  to: number;
  count: number;
}

export type DiffRow = DiffLine | DiffFold;

export interface SplitCell {
  type: LineType | "blank";
  num: number | null;
  text: string;
  emph?: Range[];
}

export type SplitRow = { kind: "pair"; l: SplitCell; r: SplitCell; hunk?: number } | DiffFold;

const blankCell: SplitCell = { type: "blank", num: null, text: "" };

// Above this product the O(n·m) LCS isn't worth it (a huge rewrite); fall back to
// a plain block diff so the UI stays responsive.
const LCS_BUDGET = 250_000;

type Op<T> = { type: "eq" | "del" | "ins"; value: T };

/** Longest-common-subsequence diff over two arrays (lines, or word tokens). */
function diffSeq<T>(a: readonly T[], b: readonly T[]): Op<T>[] {
  const n = a.length;
  const m = b.length;
  // Flat dp where dp[i*w + j] = LCS length of a[i:], b[j:]; typed-array reads are
  // always numbers, so no index gymnastics. Zero-initialized.
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const ops: Op<T>[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = a[i] as T;
    if (ai === b[j]) {
      ops.push({ type: "eq", value: ai });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      ops.push({ type: "del", value: ai });
      i++;
    } else {
      ops.push({ type: "ins", value: b[j] as T });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", value: a[i++] as T });
  while (j < m) ops.push({ type: "ins", value: b[j++] as T });
  return ops;
}

// Words, whitespace runs, and individual punctuation — granular enough that a
// one-token edit highlights just that token, not the whole line.
function tokenizeWords(line: string): string[] {
  return line.match(/[A-Za-z0-9_$]+|\s+|[^\sA-Za-z0-9_$]/g) ?? [];
}

/**
 * Word-level diff of a modified line pair → the changed char ranges on each side.
 * Returns null when the two lines are too dissimilar to be "the same line edited"
 * (so the caller highlights the whole line instead of scattering confetti).
 */
function wordEmph(oldLine: string, newLine: string): { old: Range[]; new: Range[] } | null {
  if (!oldLine || !newLine) return null;
  if (oldLine.length * newLine.length > LCS_BUDGET) return null;
  const ops = diffSeq(tokenizeWords(oldLine), tokenizeWords(newLine));
  let common = 0;
  for (const op of ops) if (op.type === "eq") common += op.value.length;
  if ((common * 2) / (oldLine.length + newLine.length) < 0.3) return null;
  const oldR: Range[] = [];
  const newR: Range[] = [];
  let op = 0;
  let np = 0;
  for (const o of ops) {
    const len = o.value.length;
    if (o.type === "eq") {
      op += len;
      np += len;
    } else if (o.type === "del") {
      oldR.push([op, op + len]);
      op += len;
    } else {
      newR.push([np, np + len]);
      np += len;
    }
  }
  return { old: oldR, new: newR };
}

/** Unified rows from hunks + a map of fetched old-file lines (number → text). */
export function buildRows(
  hunks: readonly Hunk[],
  fetched: ReadonlyMap<number, string>,
  totalLines: number,
): DiffRow[] {
  const rows: DiffRow[] = [];
  const sorted = [...hunks].sort((a, b) => a.startLine - b.startLine);

  // Walk unchanged old lines [from, to], emitting fetched ones as context and
  // collapsing contiguous unfetched gaps into a single fold row. `delta` is the
  // running new−old line offset so context carries its real new-file number too.
  const emitUnchanged = (from: number, to: number, delta: number) => {
    let i = Math.max(1, from);
    const end = Math.min(to, totalLines);
    while (i <= end) {
      const text = fetched.get(i);
      if (text !== undefined) {
        rows.push({ kind: "line", type: "ctx", oldNo: i, newNo: i + delta, text });
        i++;
      } else {
        let j = i;
        while (j <= end && !fetched.has(j)) j++;
        rows.push({ kind: "fold", from: i, to: j - 1, count: j - i });
        i = j;
      }
    }
  };

  let old = 1;
  let delta = 0; // new-file offset for unchanged lines after prior hunks
  let hunkSeq = 0;
  for (const h of sorted) {
    emitUnchanged(old, h.startLine - 1, delta);
    hunkSeq++;
    const first = rows.length;
    emitHunk(rows, h, h.startLine, h.startLine + delta);
    const head = rows[first];
    if (head && head.kind === "line") head.hunk = hunkSeq;
    delta += h.new.length - h.old.length;
    old = h.startLine + h.old.length;
  }
  emitUnchanged(old, totalLines, delta);
  return rows;
}

/** Emit one hunk's rows: line-LCS into ctx/del/add, with word-level emph on pairs. */
function emitHunk(rows: DiffRow[], h: Hunk, oldStart: number, newStart: number): void {
  let oldNum = oldStart;
  let newNum = newStart;
  // Big rewrite: skip the LCS and show a plain block (all old, then all new).
  if (h.old.length * h.new.length > LCS_BUDGET) {
    for (const t of h.old)
      rows.push({ kind: "line", type: "del", oldNo: oldNum++, newNo: null, text: t });
    for (const t of h.new)
      rows.push({ kind: "line", type: "add", oldNo: null, newNo: newNum++, text: t });
    return;
  }
  const ops = diffSeq(h.old, h.new);
  let k = 0;
  while (k < ops.length) {
    const op = ops[k] as Op<string>;
    if (op.type === "eq") {
      rows.push({ kind: "line", type: "ctx", oldNo: oldNum, newNo: newNum, text: op.value });
      oldNum++;
      newNum++;
      k++;
      continue;
    }
    // A run of deletions then insertions — pair them up for intra-line diffs.
    const dels: string[] = [];
    while (k < ops.length && (ops[k] as Op<string>).type === "del") {
      dels.push((ops[k] as Op<string>).value);
      k++;
    }
    const ins: string[] = [];
    while (k < ops.length && (ops[k] as Op<string>).type === "ins") {
      ins.push((ops[k] as Op<string>).value);
      k++;
    }
    const pairs = Math.min(dels.length, ins.length);
    dels.forEach((t, p) => {
      const e = p < pairs ? wordEmph(t, ins[p] as string) : null;
      rows.push({
        kind: "line",
        type: "del",
        oldNo: oldNum++,
        newNo: null,
        text: t,
        ...(e ? { emph: e.old } : {}),
      });
    });
    ins.forEach((t, p) => {
      const e = p < pairs ? wordEmph(dels[p] as string, t) : null;
      rows.push({
        kind: "line",
        type: "add",
        oldNo: null,
        newNo: newNum++,
        text: t,
        ...(e ? { emph: e.new } : {}),
      });
    });
  }
}

/** Side-by-side rows: pair each del with the following add; blanks fill gaps. */
export function toSplit(rows: readonly DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  // The left column numbers from the old file, the right from the new file.
  const left = (r: DiffLine): SplitCell => ({
    type: r.type,
    num: r.oldNo,
    text: r.text,
    ...(r.emph ? { emph: r.emph } : {}),
  });
  const right = (r: DiffLine): SplitCell => ({
    type: r.type,
    num: r.newNo,
    text: r.text,
    ...(r.emph ? { emph: r.emph } : {}),
  });
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (!r) break;
    if (r.kind === "fold") {
      out.push(r);
      i++;
      continue;
    }
    if (r.type === "ctx") {
      out.push({ kind: "pair", l: left(r), r: right(r), hunk: r.hunk });
      i++;
      continue;
    }
    if (r.type === "del") {
      const next = rows[i + 1];
      if (next && next.kind === "line" && next.type === "add") {
        out.push({ kind: "pair", l: left(r), r: right(next), hunk: r.hunk });
        i += 2;
      } else {
        out.push({ kind: "pair", l: left(r), r: blankCell, hunk: r.hunk });
        i++;
      }
      continue;
    }
    // lone add
    out.push({ kind: "pair", l: blankCell, r: right(r), hunk: r.hunk });
    i++;
  }
  return out;
}

/** Count truly added/removed lines (via the line-LCS), for headers & siblings. */
export function countAddsDels(toolName: string, payload: unknown): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const h of toHunks(toolName, payload)) {
    if (h.old.length === 0) {
      adds += h.new.length;
      continue;
    }
    if (h.old.length * h.new.length > LCS_BUDGET) {
      adds += h.new.length;
      dels += h.old.length;
      continue;
    }
    for (const op of diffSeq(h.old, h.new)) {
      if (op.type === "ins") adds++;
      else if (op.type === "del") dels++;
    }
  }
  return { adds, dels };
}

/** A compact "L120–172" range label spanning all of an edit's hunks (old file). */
export function rangeLabel(hunks: readonly Hunk[]): string {
  if (hunks.length === 0) return "";
  let lo = Number.POSITIVE_INFINITY;
  let hi = 0;
  for (const h of hunks) {
    lo = Math.min(lo, h.startLine);
    hi = Math.max(hi, h.startLine + Math.max(h.old.length, 1) - 1);
  }
  return hi > lo ? `L${lo}–${hi}` : `L${lo}`;
}
