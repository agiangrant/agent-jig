import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { RepoGraph } from "./graph.ts";
import { ImportExtractor } from "./imports.ts";

// A miniature monorepo: a package with a barrel re-export, and another package
// that imports it by workspace alias — the two cases LSP findReferences misses.
const root = realpathSync(mkdtempSync(join(tmpdir(), "codegraph-graph-")));
function write(rel: string, body: string): string {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
  return abs;
}

let graph: RepoGraph;
let pacer: string;
let barrel: string;
let pacerTest: string;
let appMain: string;

beforeAll(async () => {
  write(
    "packages/core/package.json",
    JSON.stringify({ name: "@scope/core", exports: { ".": "./src/index.ts" } }),
  );
  pacer = write("packages/core/src/pacer.ts", "export const Pacer = 1\n");
  barrel = write("packages/core/src/index.ts", 'export * from "./pacer.ts"\n');
  pacerTest = write("packages/core/src/pacer.test.ts", 'import { Pacer } from "./pacer.ts"\n');
  write("apps/app/package.json", JSON.stringify({ name: "@scope/app" }));
  appMain = write("apps/app/src/main.ts", 'import { Pacer } from "@scope/core"\n');
  graph = new RepoGraph(root, await ImportExtractor.create());
});

const rel = (p: string) => p.replace(`${root}/`, "");

describe("RepoGraph dependents (imported by)", () => {
  it("finds the barrel that re-exports a file via `export *` (no symbol token)", () => {
    const deps = graph.dependentsOf(pacer).map(rel).sort();
    // The barrel and the sibling test import pacer.ts directly (1 hop)…
    expect(deps).toEqual(["packages/core/src/index.ts", "packages/core/src/pacer.test.ts"]);
    // …but the app, which imports the package alias, does NOT (it's 2 hops, via the barrel).
    expect(deps).not.toContain(rel(appMain));
  });

  it("resolves workspace aliases so the barrel's cross-package importer is found", () => {
    expect(graph.dependentsOf(barrel).map(rel)).toEqual(["apps/app/src/main.ts"]);
  });
});

describe("RepoGraph dependencies (it imports)", () => {
  it("resolves a `@scope/pkg` alias to the package entry", () => {
    expect(graph.dependenciesOf(appMain).map(rel)).toEqual(["packages/core/src/index.ts"]);
  });

  it("resolves a relative re-export source", () => {
    expect(graph.dependenciesOf(barrel).map(rel)).toEqual(["packages/core/src/pacer.ts"]);
  });

  it("drops cached graph on invalidate without erroring", () => {
    graph.invalidate();
    expect(graph.dependentsOf(pacer).map(rel)).toContain("packages/core/src/index.ts");
  });

  it("returns nothing for a file no one imports", () => {
    expect(graph.dependentsOf(pacerTest)).toEqual([]);
  });
});

describe("RepoGraph with tsconfig paths", () => {
  it("resolves a `paths` alias (e.g. @app/*) in both directions", async () => {
    const r = realpathSync(mkdtempSync(join(tmpdir(), "codegraph-paths-")));
    const w = (rel: string, body: string) => {
      const abs = join(r, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, body);
      return abs;
    };
    w(
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } } }),
    );
    const util = w("src/util.ts", "export const x = 1\n");
    const main = w("src/main.ts", 'import { x } from "@app/util"\n');
    const g = new RepoGraph(r, await ImportExtractor.create());
    const rel = (p: string) => p.replace(`${r}/`, "");
    expect(g.dependenciesOf(main).map(rel)).toEqual(["src/util.ts"]);
    expect(g.dependentsOf(util).map(rel)).toEqual(["src/main.ts"]);
  });
});
