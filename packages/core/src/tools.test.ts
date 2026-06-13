import { describe, expect, it } from "vitest";
import { extractPath, isWriteClass } from "./tools.ts";

describe("isWriteClass", () => {
  it("gates write-class tools", () => {
    expect(isWriteClass("Edit")).toBe(true);
    expect(isWriteClass("Write")).toBe(true);
    expect(isWriteClass("MultiEdit")).toBe(true);
  });

  it("lets read/search tools pass", () => {
    expect(isWriteClass("Read")).toBe(false);
    expect(isWriteClass("Grep")).toBe(false);
    expect(isWriteClass("Bash")).toBe(false);
  });
});

describe("extractPath", () => {
  it("reads file_path from Edit/Write input", () => {
    expect(extractPath({ file_path: "src/a.ts", content: "x" })).toBe("src/a.ts");
  });

  it("reads notebook_path from NotebookEdit input", () => {
    expect(extractPath({ notebook_path: "nb.ipynb" })).toBe("nb.ipynb");
  });

  it("returns null when there is no path", () => {
    expect(extractPath({ pattern: "foo" })).toBeNull();
    expect(extractPath(null)).toBeNull();
    expect(extractPath("nope")).toBeNull();
  });
});
