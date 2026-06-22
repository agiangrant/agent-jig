import { describe, expect, it } from "vitest";
import { layoutImpactMap, type NeighborRef } from "./layout.ts";

const ref = (path: string, over: Partial<NeighborRef> = {}): NeighborRef => ({
  path,
  label: path.split("/").pop() ?? path,
  hasTests: true,
  reachedByEdit: false,
  cyclic: false,
  ...over,
});

describe("layoutImpactMap", () => {
  it("places the focus dead center with an edit badge", () => {
    const { nodes } = layoutImpactMap({
      focus: { path: "a/x.ts", label: "x.ts", edits: 3, hasTests: false },
      dependents: [],
      dependencies: [],
    });
    const focus = nodes.find((n) => n.kind === "editing");
    expect(focus).toMatchObject({ x: 300, y: 200, meta: "3 edits" });
  });

  it("orients edges by direction (dependent→focus, focus→dependency)", () => {
    const { edges } = layoutImpactMap({
      focus: { path: "f.ts", label: "f.ts", edits: 0, hasTests: true },
      dependents: [ref("dep.ts")],
      dependencies: [ref("lib.ts")],
    });
    expect(edges).toContainEqual({ from: "dep.ts", to: "f.ts", kind: "imports-it", cyclic: false });
    expect(edges).toContainEqual({ from: "f.ts", to: "lib.ts", kind: "it-imports", cyclic: false });
  });

  it("elides past the per-side cap into a single +N more node", () => {
    const deps = Array.from({ length: 5 }, (_, i) => ref(`d${i}.ts`));
    const { nodes } = layoutImpactMap({
      focus: { path: "f.ts", label: "f.ts", edits: 0, hasTests: true },
      dependents: deps,
      dependencies: [],
      maxPerSide: 3,
    });
    const more = nodes.find((n) => n.kind === "more");
    expect(more?.label).toBe("+2 more");
    expect(nodes.filter((n) => n.kind === "imports-it")).toHaveLength(3);
  });

  it("ranks edited-symbol hits first, then alphabetical, deterministically", () => {
    const out1 = layoutImpactMap({
      focus: { path: "f.ts", label: "f.ts", edits: 0, hasTests: true },
      dependents: [ref("b.ts"), ref("a.ts", { reachedByEdit: true }), ref("c.ts")],
      dependencies: [],
    });
    const out2 = layoutImpactMap({
      focus: { path: "f.ts", label: "f.ts", edits: 0, hasTests: true },
      dependents: [ref("c.ts"), ref("b.ts"), ref("a.ts", { reachedByEdit: true })],
      dependencies: [],
    });
    const order = (o: typeof out1) =>
      o.nodes.filter((n) => n.kind === "imports-it").map((n) => n.label);
    expect(order(out1)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(order(out1)).toEqual(order(out2)); // stable regardless of input order
  });

  it("marks 'no tests' on neighbors lacking coverage", () => {
    const { nodes } = layoutImpactMap({
      focus: { path: "f.ts", label: "f.ts", edits: 0, hasTests: true },
      dependents: [ref("untested.ts", { hasTests: false })],
      dependencies: [],
    });
    expect(nodes.find((n) => n.label === "untested.ts")?.meta).toBe("no tests");
  });
});
