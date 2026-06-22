import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildImpactMap, type CodeGraphProvider, type FileRef } from "./index.ts";

// A real temp dir so canonical()/inRepo() resolve; neighbor files need not exist.
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "codegraph-")));
const abs = (p: string) => join(ROOT, p);

function fakeProvider(over: Partial<CodeGraphProvider> = {}): CodeGraphProvider {
  return {
    dependencies: async () => [],
    dependents: async () => [],
    capabilities: () => ({ references: true }),
    ...over,
  };
}

const noTests = () => false;

describe("buildImpactMap", () => {
  it("assembles both edge directions and counts the ripple", async () => {
    const provider = fakeProvider({
      dependencies: async () => [{ path: abs("lib/util.ts") }],
      dependents: async (): Promise<FileRef[]> => [
        { path: abs("a.ts"), reachedByEdit: true },
        { path: abs("b.ts"), reachedByEdit: false },
      ],
    });
    const map = await buildImpactMap({
      focus: abs("core.ts"),
      repoRoot: ROOT,
      editedSymbols: [{ name: "foo", line: 0, character: 0 }],
      edits: 2,
      provider,
      hasTests: noTests,
    });

    expect(map.focus).toBe("core.ts");
    expect(map.degraded).toBe(false);
    expect(map.rippleCount).toBe(2); // total dependents (the "imported by" count)
    expect(
      map.nodes
        .filter((n) => n.kind === "imports-it")
        .map((n) => n.label)
        .sort(),
    ).toEqual(["a.ts", "b.ts"]);
    expect(map.nodes.find((n) => n.kind === "it-imports")?.label).toBe("util.ts");
  });

  it("degrades when the provider has no references (no language server)", async () => {
    const provider = fakeProvider({
      dependencies: async () => [{ path: abs("lib/util.ts") }],
      capabilities: () => ({ references: false }),
      installable: () => ({ serverId: "gopls", languageId: "go" }),
    });
    const map = await buildImpactMap({
      focus: abs("main.go"),
      repoRoot: ROOT,
      editedSymbols: [],
      edits: 0,
      provider,
      hasTests: noTests,
    });
    expect(map.degraded).toBe(true);
    expect(map.nodes.some((n) => n.kind === "imports-it")).toBe(false); // dependents skipped
    expect(map.nodes.some((n) => n.kind === "it-imports")).toBe(true); // dependencies still shown
    expect(map.install).toEqual({ serverId: "gopls", languageId: "go", installing: false });
  });

  it("renders a circular import as a cyclic back-edge, not a re-expansion", async () => {
    // cycle.ts both imports and is imported by the focus.
    const provider = fakeProvider({
      dependencies: async () => [{ path: abs("cycle.ts") }],
      dependents: async () => [{ path: abs("cycle.ts") }],
    });
    const map = await buildImpactMap({
      focus: abs("core.ts"),
      repoRoot: ROOT,
      editedSymbols: [],
      edits: 0,
      provider,
      hasTests: noTests,
    });
    const cyclicEdges = map.edges.filter((e) => e.cyclic);
    expect(cyclicEdges).toHaveLength(1);
    // The back-edge is on the dependents side.
    expect(cyclicEdges.map((e) => e.kind)).toEqual(["imports-it"]);
  });

  it("drops node_modules and out-of-repo neighbors", async () => {
    const provider = fakeProvider({
      dependencies: async () => [
        { path: abs("node_modules/zod/index.ts") },
        { path: "/etc/passwd" },
        { path: abs("real.ts") },
      ],
    });
    const map = await buildImpactMap({
      focus: abs("core.ts"),
      repoRoot: ROOT,
      editedSymbols: [],
      edits: 0,
      provider,
      hasTests: noTests,
    });
    expect(map.nodes.filter((n) => n.kind === "it-imports").map((n) => n.label)).toEqual([
      "real.ts",
    ]);
  });
});
