import { describe, expect, it } from "vitest";
import type { Hunk } from "./diff.ts";
import { buildRows, countAddsDels, type DiffFold, rangeLabel, toSplit } from "./fileDiff.ts";

// One hunk replacing old line 3 (`c`) with two added lines.
const hunk: Hunk = { old: ["c"], new: ["C1", "C2"], startLine: 3 };

describe("buildRows", () => {
  it("collapses unfetched unchanged regions into folds sized from totalLines", () => {
    // Nothing fetched: a fold above the hunk (1–2) and below it (4–6).
    const rows = buildRows([hunk], new Map(), 6);
    const folds = rows.filter((r): r is DiffFold => r.kind === "fold");
    expect(folds).toEqual([
      { kind: "fold", from: 1, to: 2, count: 2 },
      { kind: "fold", from: 4, to: 6, count: 3 },
    ]);
    // The hunk itself: one del then two adds, del marked as the change head.
    const lines = rows.filter((r) => r.kind === "line");
    expect(lines).toEqual([
      { kind: "line", type: "del", oldNo: 3, newNo: null, text: "c", hunk: 1 },
      { kind: "line", type: "add", oldNo: null, newNo: 3, text: "C1" },
      { kind: "line", type: "add", oldNo: null, newNo: 4, text: "C2" },
    ]);
  });

  it("emits fetched lines as context instead of folds", () => {
    const fetched = new Map([
      [1, "a"],
      [2, "b"],
      [4, "d"],
    ]);
    const rows = buildRows([hunk], fetched, 4);
    expect(rows.filter((r) => r.kind === "fold")).toEqual([]);
    expect(rows[0]).toEqual({ kind: "line", type: "ctx", oldNo: 1, newNo: 1, text: "a" });
    // Trailing context carries both numbers; new = old + delta (+1 after the hunk).
    expect(rows.at(-1)).toEqual({ kind: "line", type: "ctx", oldNo: 4, newNo: 5, text: "d" });
  });

  it("orders multiple hunks and gives each its own change index", () => {
    const h2: Hunk = { old: ["x"], new: ["X"], startLine: 8 };
    const rows = buildRows([h2, hunk], new Map(), 10); // intentionally unsorted
    const heads = rows.filter((r) => r.kind === "line" && r.hunk !== undefined);
    expect(heads.map((h) => (h.kind === "line" ? (h.oldNo ?? h.newNo) : 0))).toEqual([3, 8]);
  });
});

describe("buildRows line-level LCS", () => {
  it("keeps re-emitted unchanged lines as context, not delete+add", () => {
    // The agent rewrote the block but only the middle line actually changed.
    const h: Hunk = { old: ["a", "b", "c"], new: ["a", "B", "c"], startLine: 1 };
    const rows = buildRows([h], new Map(), 3).filter((r) => r.kind === "line");
    expect(rows.map((r) => (r.kind === "line" ? `${r.type}:${r.text}` : ""))).toEqual([
      "ctx:a",
      "del:b",
      "add:B",
      "ctx:c",
    ]);
  });

  it("marks the changed words on a modified line (intra-line emph)", () => {
    const h: Hunk = { old: ["const x = foo(a, b)"], new: ["const x = foo(a, c)"], startLine: 1 };
    const rows = buildRows([h], new Map(), 1).filter((r) => r.kind === "line");
    const add = rows.find((r) => r.kind === "line" && r.type === "add");
    expect(add?.kind === "line" && add.emph).toBeTruthy();
    // The emphasized range should cover only the changed token, not the whole line.
    const span = (add?.kind === "line" && add.emph?.[0]) || [0, 999];
    expect(span[1] - span[0]).toBeLessThan("const x = foo(a, c)".length);
  });

  it("numbers ctx/del with old lines and add with new lines", () => {
    // a unchanged, b→B, c unchanged, starting at old line 10.
    const h: Hunk = { old: ["a", "b", "c"], new: ["a", "B", "c"], startLine: 10 };
    const rows = buildRows([h], new Map(), 12).filter((r) => r.kind === "line");
    const tag = (r: { type: string; oldNo: number | null; newNo: number | null; text: string }) =>
      `${r.type}:${r.oldNo ?? "-"}/${r.newNo ?? "-"}:${r.text}`;
    expect(rows.map((r) => (r.kind === "line" ? tag(r) : ""))).toEqual([
      "ctx:10/10:a",
      "del:11/-:b",
      "add:-/11:B",
      "ctx:12/12:c",
    ]);
  });

  it("shifts add numbers by the net line change of earlier hunks", () => {
    const h1: Hunk = { old: ["x"], new: ["X1", "X2"], startLine: 5 }; // net +1
    const h2: Hunk = { old: ["y"], new: ["Y"], startLine: 20 };
    const rows = buildRows([h1, h2], new Map(), 30).filter((r) => r.kind === "line");
    // h1: del x at old 5; adds X1/X2 at new 5,6.
    expect(rows.find((r) => r.kind === "line" && r.text === "X2")).toMatchObject({ newNo: 6 });
    // h2: del y at old 20; add Y at new 20 + 1 (the earlier net change) = 21.
    expect(rows.find((r) => r.kind === "line" && r.text === "y")).toMatchObject({ oldNo: 20 });
    expect(rows.find((r) => r.kind === "line" && r.text === "Y")).toMatchObject({ newNo: 21 });
  });

  it("leaves a wholly-rewritten line without emph (highlight the whole line)", () => {
    const h: Hunk = { old: ["totally different"], new: ["nothing alike here"], startLine: 1 };
    const rows = buildRows([h], new Map(), 1).filter((r) => r.kind === "line");
    const add = rows.find((r) => r.kind === "line" && r.type === "add");
    expect(add?.kind === "line" && add.emph).toBeUndefined();
  });
});

describe("toSplit", () => {
  it("pairs a del with the following add and blanks the surplus", () => {
    const split = toSplit(buildRows([hunk], new Map([[3, "c"]]), 3));
    const pair = split.find((r) => r.kind === "pair" && r.l.type !== "blank");
    // First change row: del on the left, first add on the right.
    expect(pair).toMatchObject({ l: { type: "del", text: "c" }, r: { type: "add", text: "C1" } });
    // The extra add (C2) gets a blank left cell.
    const lone = split.find((r) => r.kind === "pair" && r.l.type === "blank");
    expect(lone).toMatchObject({ l: { type: "blank" }, r: { type: "add", text: "C2" } });
  });
});

describe("countAddsDels & rangeLabel", () => {
  it("counts only the truly changed lines (LCS), not the whole block", () => {
    // "a" is unchanged → just one deletion.
    expect(countAddsDels("Edit", { old_string: "a\nb", new_string: "a", startLine: 5 })).toEqual({
      adds: 0,
      dels: 1,
    });
    // "a" unchanged, "b" → "c" is one del + one add.
    expect(countAddsDels("Edit", { old_string: "a\nb", new_string: "a\nc", startLine: 5 })).toEqual(
      {
        adds: 1,
        dels: 1,
      },
    );
  });

  it("labels a single-line vs multi-line span", () => {
    expect(rangeLabel([{ old: ["a"], new: ["b"], startLine: 5 }])).toBe("L5");
    expect(rangeLabel([hunk])).toBe("L3");
    expect(rangeLabel([{ old: ["a", "b", "c"], new: [], startLine: 10 }])).toBe("L10–12");
  });
});
