import type { LineComment, ReviewComment } from "@agent-jig/contracts";
import { describe, expect, it } from "vitest";
import {
  composeAllComments,
  composeEditFeedback,
  composeReviewFeedback,
  type EditCommentGroup,
  groupCommentsByEdit,
} from "./comments.ts";

function comment(over: Partial<LineComment>): LineComment {
  return {
    id: "c1",
    editId: "e1",
    path: "src/a.ts",
    side: "new",
    line: 42,
    lineText: "const x = doThing()",
    body: "handle the null case",
    ...over,
  };
}

function group(path: string, comments: LineComment[]): EditCommentGroup {
  return { editId: comments[0]?.editId ?? "e1", path, comments };
}

describe("groupCommentsByEdit", () => {
  it("groups by editId preserving first-seen order", () => {
    const groups = groupCommentsByEdit([
      comment({ editId: "e1", path: "src/a.ts", line: 1 }),
      comment({ editId: "e2", path: "src/b.ts", line: 2 }),
      comment({ editId: "e1", path: "src/a.ts", line: 3 }),
    ]);
    expect(groups.map((g) => g.editId)).toEqual(["e1", "e2"]);
    expect(groups.map((g) => g.comments.length)).toEqual([2, 1]);
    expect(groups.map((g) => g.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("composeEditFeedback", () => {
  it("formats a Re: header and a bullet per comment with line context", () => {
    const g = group("src/a.ts", [
      comment({ line: 42, lineText: "const x = doThing()", body: "handle the null case" }),
      comment({ line: 55, lineText: "  return x", body: "add a guard here" }),
    ]);
    expect(composeEditFeedback(g)).toBe(
      "Re: your edit to src/a.ts:\n" +
        "- L42 (`const x = doThing()`): handle the null case\n" +
        "- L55 (`return x`): add a guard here",
    );
  });

  it("appends shared free text after the bullets", () => {
    const g = group("src/a.ts", [comment({ body: "fix this" })]);
    expect(composeEditFeedback(g, "  also rename the function  ")).toBe(
      "Re: your edit to src/a.ts:\n- L42 (`const x = doThing()`): fix this\n\nalso rename the function",
    );
  });

  it("omits the code snippet when the line is blank", () => {
    const g = group("src/a.ts", [comment({ lineText: "   ", body: "drop this" })]);
    expect(composeEditFeedback(g)).toBe("Re: your edit to src/a.ts:\n- L42: drop this");
  });
});

describe("composeAllComments", () => {
  it("joins every edit's block, free text last", () => {
    const out = composeAllComments(
      [
        comment({ editId: "e1", path: "src/a.ts", line: 1, lineText: "a", body: "x" }),
        comment({ editId: "e2", path: "src/b.ts", line: 2, lineText: "b", body: "y" }),
      ],
      "ship it",
    );
    expect(out).toBe(
      "Re: your edit to src/a.ts:\n- L1 (`a`): x\n\n" +
        "Re: your edit to src/b.ts:\n- L2 (`b`): y\n\n" +
        "ship it",
    );
  });

  it("handles no free text", () => {
    const out = composeAllComments([comment({ line: 1, lineText: "a", body: "x" })]);
    expect(out).toBe("Re: your edit to src/a.ts:\n- L1 (`a`): x");
  });
});

function review(over: Partial<ReviewComment>): ReviewComment {
  return {
    id: "r1",
    author: "human",
    model: null,
    path: "src/a.ts",
    side: "new",
    line: 10,
    lineText: "const x = 1;",
    body: "rename this",
    severity: "info",
    resolved: false,
    deleted: false,
    createdAt: 0,
    ...over,
  };
}

describe("composeReviewFeedback", () => {
  it("groups review comments by file with an intro and tags AI authors", () => {
    const out = composeReviewFeedback(
      [
        review({ path: "src/a.ts", line: 10, lineText: "const x = 1;", body: "rename this" }),
        review({
          author: "gemini",
          path: "src/b.ts",
          line: 4,
          lineText: "let y",
          body: "use const",
        }),
      ],
      "overall: tidy up",
    );
    expect(out).toBe(
      "Please address this code review:\n\n" +
        "Re: src/a.ts:\n- L10 (`const x = 1;`): rename this\n\n" +
        "Re: src/b.ts:\n- L4 (`let y`) [gemini review]: use const\n\n" +
        "overall: tidy up",
    );
  });
});
