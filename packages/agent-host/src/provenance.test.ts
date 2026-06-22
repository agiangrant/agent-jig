import type { DetectedChange } from "@agent-jig/worktree";
import { describe, expect, it } from "vitest";
import { ProvenanceTracker } from "./provenance.ts";

function fakeWorktree(scripted: DetectedChange[][]) {
  const expectedCalls: string[][] = [];
  const detect = (expected: string[] = []) => {
    expectedCalls.push(expected);
    return scripted.shift() ?? [];
  };
  return { detect, expectedCalls };
}

describe("ProvenanceTracker", () => {
  it("returns null for read/search tools and never checks the worktree", () => {
    const wt = fakeWorktree([]);
    const t = new ProvenanceTracker(wt);
    expect(t.observe("Read", { file_path: "a.ts" })).toBeNull();
    expect(t.observe("Grep", { pattern: "x" })).toBeNull();
    expect(wt.expectedCalls).toHaveLength(0);
  });

  it("flags out-of-band changes at a write boundary, attributed to bash when a Bash ran", () => {
    const wt = fakeWorktree([[{ path: "z.ts", kind: "added" }]]);
    const t = new ProvenanceTracker(wt);
    t.observe("Bash", { command: "echo hi > z.ts" });
    const change = t.observe("Edit", { file_path: "a.ts" });
    expect(change).toEqual({ attributedTo: "bash", files: [{ path: "z.ts", kind: "added" }] });
  });

  it("attributes to external when no Bash ran in the interval", () => {
    const wt = fakeWorktree([[{ path: "h.ts", kind: "modified" }]]);
    const t = new ProvenanceTracker(wt);
    const change = t.observe("Write", { file_path: "a.ts" });
    expect(change?.attributedTo).toBe("external");
  });

  it("returns null when nothing changed out of band", () => {
    const wt = fakeWorktree([[]]);
    const t = new ProvenanceTracker(wt);
    expect(t.observe("Edit", { file_path: "a.ts" })).toBeNull();
  });

  it("excludes the previous write's target from the next check", () => {
    const wt = fakeWorktree([[], []]);
    const t = new ProvenanceTracker(wt);
    t.observe("Edit", { file_path: "first.ts" }); // checks with [] (no prior write)
    t.observe("Edit", { file_path: "second.ts" }); // checks excluding first.ts
    expect(wt.expectedCalls).toEqual([[], ["first.ts"]]);
  });
});
