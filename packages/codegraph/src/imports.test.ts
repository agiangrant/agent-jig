import { beforeAll, describe, expect, it } from "vitest";
import { ImportExtractor, langForPath } from "./imports.ts";

let extractor: ImportExtractor;
beforeAll(async () => {
  extractor = await ImportExtractor.create();
});

describe("langForPath", () => {
  it("maps extensions to grammars", () => {
    expect(langForPath("a.tsx")).toBe("tsx");
    expect(langForPath("a.ts")).toBe("ts");
    expect(langForPath("a.mts")).toBe("ts");
    expect(langForPath("a.mjs")).toBe("js");
    expect(langForPath("a.go")).toBeNull();
  });
});

describe("ImportExtractor", () => {
  it("finds static, type-only, re-export, dynamic and require specifiers", () => {
    const src = [
      `import { a } from "./a"`,
      `import type { T } from "./types"`,
      `export { x } from "./barrel"`,
      `const m = await import("./lazy")`,
      `const r = require("./legacy")`,
    ].join("\n");
    const sites = extractor.extract(src, "ts");
    const specs = sites.map((s) => s.specifier).sort();
    expect(specs).toEqual(["./a", "./barrel", "./lazy", "./legacy", "./types"]);
    expect(sites.find((s) => s.specifier === "./types")?.typeOnly).toBe(true);
    expect(sites.find((s) => s.specifier === "./a")?.typeOnly).toBe(false);
  });

  it("returns an LSP position inside the specifier string", () => {
    const src = `import { a } from "./a"`;
    const sites = extractor.extract(src, "ts");
    expect(sites).toHaveLength(1);
    const site = sites[0];
    if (!site) throw new Error("expected one import site");
    // The opening quote is at column 18; the specifier starts at 19.
    expect(site.line).toBe(0);
    expect(site.character).toBe(19);
    expect(src.slice(site.character, site.character + 3)).toBe("./a");
  });

  it("ignores non-import strings", () => {
    const src = `const greeting = "hello world"\nfunction f() { return "./not-an-import" }`;
    expect(extractor.extract(src, "ts")).toHaveLength(0);
  });
});
