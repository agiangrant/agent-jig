import type { ReviewFileDiff } from "@agent-jig/contracts";
import { describe, expect, it } from "vitest";
import { buildReviewPrompt, parseReviewComments } from "./reviewer.ts";

describe("parseReviewComments", () => {
  it("parses a bare JSON array", () => {
    const out = parseReviewComments(
      '[{"path":"a.ts","line":3,"side":"new","severity":"issue","body":"null deref"}]',
    );
    expect(out).toEqual([
      { path: "a.ts", line: 3, side: "new", severity: "issue", body: "null deref" },
    ]);
  });

  it("extracts JSON from a ```json fence with surrounding prose", () => {
    const text =
      'Here is my review:\n```json\n[{"path":"b.ts","line":10,"body":"rename"}]\n```\nThanks!';
    const out = parseReviewComments(text);
    expect(out).toEqual([
      { path: "b.ts", line: 10, side: "new", severity: "info", body: "rename" },
    ]);
  });

  it("defaults side/severity and skips malformed entries", () => {
    const out = parseReviewComments(
      '[{"path":"a.ts","line":1,"body":"ok"},{"line":2,"body":"no path"},{"path":"c.ts","body":"no line"}]',
    );
    expect(out).toEqual([{ path: "a.ts", line: 1, side: "new", severity: "info", body: "ok" }]);
  });

  it("returns [] for non-JSON or empty arrays", () => {
    expect(parseReviewComments("no json here")).toEqual([]);
    expect(parseReviewComments("[]")).toEqual([]);
    expect(parseReviewComments("looks good, no issues")).toEqual([]);
  });
});

describe("buildReviewPrompt", () => {
  it("renders the diff with line numbers and the task", () => {
    const files: ReviewFileDiff[] = [
      {
        path: "a.ts",
        oldPath: null,
        status: "modified",
        hunks: [
          {
            header: "@@ -1,2 +1,2 @@",
            rows: [
              { kind: "context", text: "const x = 1;", oldLine: 1, newLine: 1 },
              { kind: "add", text: "const y = 3;", oldLine: null, newLine: 2 },
            ],
          },
        ],
      },
    ];
    const prompt = buildReviewPrompt(files, "do the thing", "AGENT TOOL: Edit a.ts");
    expect(prompt).toContain("do the thing");
    expect(prompt).toContain("AGENT TOOL: Edit a.ts");
    expect(prompt).toContain("File: a.ts");
    expect(prompt).toContain("+    2 | const y = 3;");
  });
});
