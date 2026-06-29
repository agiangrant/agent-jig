import { isWriteClass } from "@agent-jig/core";
import { describe, expect, it } from "vitest";
import { codexChangesToJig, parseUnifiedDiff } from "./apply-patch.ts";

describe("parseUnifiedDiff", () => {
  it("parses a single hunk into old/new text", () => {
    const diff = [
      "@@ -1,3 +1,3 @@",
      " const x = 1;",
      "-const y = 2;",
      "+const y = 3;",
      " return x;",
    ].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([
      {
        oldText: "const x = 1;\nconst y = 2;\nreturn x;",
        newText: "const x = 1;\nconst y = 3;\nreturn x;",
      },
    ]);
  });

  it("splits multiple hunks", () => {
    const diff = ["@@ -1 +1 @@", "-one", "+ONE", "@@ -5 +5 @@", "-two", "+TWO"].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([
      { oldText: "one", newText: "ONE" },
      { oldText: "two", newText: "TWO" },
    ]);
  });

  it("ignores file-header lines before the first hunk", () => {
    const diff = ["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "-a", "+b"].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([{ oldText: "a", newText: "b" }]);
  });
});

describe("codexChangesToJig", () => {
  it("maps a single add → Write with full content", () => {
    const r = codexChangesToJig([{ path: "n.ts", kind: { type: "add" }, diff: "line1\nline2" }]);
    expect(r).toEqual({ toolName: "Write", input: { file_path: "n.ts", content: "line1\nline2" } });
    expect(isWriteClass(r.toolName)).toBe(true);
  });

  it("maps a single-hunk update → Edit", () => {
    const r = codexChangesToJig([
      { path: "a.ts", kind: { type: "update" }, diff: ["@@ -1 +1 @@", "-a", "+b"].join("\n") },
    ]);
    expect(r).toEqual({
      toolName: "Edit",
      input: { file_path: "a.ts", old_string: "a", new_string: "b" },
    });
  });

  it("maps a multi-hunk update → MultiEdit", () => {
    const r = codexChangesToJig([
      {
        path: "a.ts",
        kind: { type: "update" },
        diff: ["@@ -1 +1 @@", "-a", "+b", "@@ -9 +9 @@", "-c", "+d"].join("\n"),
      },
    ]);
    expect(r.toolName).toBe("MultiEdit");
    expect(r.input.edits).toEqual([
      { old_string: "a", new_string: "b" },
      { old_string: "c", new_string: "d" },
    ]);
  });

  it("gates a delete as an emptying Write so it is still reviewed", () => {
    const r = codexChangesToJig([
      { path: "gone.ts", kind: { type: "delete" }, diff: "old content" },
    ]);
    expect(r.toolName).toBe("Write");
    expect(r.input).toMatchObject({ file_path: "gone.ts", codexDelete: true });
    expect(isWriteClass(r.toolName)).toBe(true);
  });

  it("gates a multi-file envelope as one MultiEdit keyed on the first file", () => {
    const r = codexChangesToJig([
      { path: "first.ts", kind: { type: "add" }, diff: "x" },
      { path: "second.ts", kind: { type: "update" }, diff: ["@@ -1 +1 @@", "-a", "+b"].join("\n") },
    ]);
    expect(r.toolName).toBe("MultiEdit");
    expect(r.input.file_path).toBe("first.ts");
    expect(Array.isArray(r.input.patch)).toBe(true);
    expect(isWriteClass(r.toolName)).toBe(true);
  });
});
