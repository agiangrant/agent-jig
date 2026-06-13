import { beforeAll, describe, expect, it } from "vitest";
import { type EditForAnalysis, StructuralAnalyzer } from "./index.ts";

const edit = (
  editId: string,
  oldString: string,
  newString: string,
  path = "src/x.ts",
): EditForAnalysis => ({ editId, path, oldString, newString });

let analyzer: StructuralAnalyzer;
beforeAll(async () => {
  analyzer = await StructuralAnalyzer.create();
});

describe("StructuralAnalyzer.analyzeGroup", () => {
  it("clusters structurally identical transforms and flags the outlier", () => {
    const result = analyzer.analyzeGroup([
      edit("a", "foo()", "await foo()"),
      edit("b", "bar()", "await bar()"),
      edit("c", "baz()", "await baz()"),
      edit("d", "const x = 1;", "const x = 2;"),
    ]);
    expect(result.pattern?.count).toBe(3);
    expect([...(result.pattern?.editIds ?? [])].sort()).toEqual(["a", "b", "c"]);
    expect(result.outliers).toEqual(["d"]);
  });

  it("clusters across different identifiers (the point of AST sameness)", () => {
    const result = analyzer.analyzeGroup([
      edit("a", "a.save()", "await a.save()"),
      edit("b", "different.thing()", "await different.thing()"),
    ]);
    expect(result.pattern?.count).toBe(2);
  });

  it("treats a structurally different sibling as an outlier", () => {
    const result = analyzer.analyzeGroup([
      edit("a", "log(x)", "logger.info(x)"),
      edit("b", "log(y)", "logger.info(y)"),
      edit("c", "log(z)", "logger.info(z)"),
      edit("d", "log(w)", "logger.info(w, opts)"), // extra argument → different shape
    ]);
    expect([...(result.pattern?.editIds ?? [])].sort()).toEqual(["a", "b", "c"]);
    expect(result.outliers).toEqual(["d"]);
  });

  it("returns no pattern when every edit is structurally distinct", () => {
    const result = analyzer.analyzeGroup([
      edit("a", "foo()", "await foo()"),
      edit("b", "const x = 1;", "let x = 1;"),
    ]);
    expect(result.pattern).toBeNull();
    expect(result.outliers).toEqual([]);
  });
});
