import type { ImpactEdge, ImpactNode } from "@agent-jig/contracts";

/** A resolved 1-hop neighbor, repo-relative, ready to place. */
export interface NeighborRef {
  path: string;
  label: string;
  hasTests: boolean;
  reachedByEdit: boolean;
  /** A back-edge to an already-seen node (circular import). Rendered, not expanded. */
  cyclic: boolean;
}

export interface LayoutInput {
  focus: { path: string; label: string; edits: number; hasTests: boolean };
  /** Files that import the focus ("imports it"), placed on the left. */
  dependents: NeighborRef[];
  /** Files the focus imports ("it imports"), placed on the right. */
  dependencies: NeighborRef[];
  maxPerSide?: number;
}

// The design renders into a 600x400 viewBox; positions are absolute within it.
const W = 600;
const H = 400;
const TOP = 40;
const BOTTOM = H - 40;
const DEFAULT_MAX = 12;

/**
 * Deterministic layered layout: dependents column (left), focus (center),
 * dependencies column (right). The node count is bounded (1-hop + per-side cap),
 * so a naive layered placement is enough — no force simulation, no graph library.
 * Ordering is stable (edited-symbol hits first, then alphabetical) so the graph
 * does not jump between recomputes.
 */
export function layoutImpactMap(input: LayoutInput): { nodes: ImpactNode[]; edges: ImpactEdge[] } {
  const max = input.maxPerSide ?? DEFAULT_MAX;
  const nodes: ImpactNode[] = [];
  const edges: ImpactEdge[] = [];

  nodes.push({
    path: input.focus.path,
    kind: "editing",
    x: W / 2,
    y: H / 2,
    label: input.focus.label,
    meta:
      input.focus.edits > 0 ? `${input.focus.edits} edit${input.focus.edits > 1 ? "s" : ""}` : "",
    hasTests: input.focus.hasTests,
    edits: input.focus.edits,
    reachedByEdit: false,
  });

  placeColumn(input.dependents, "imports-it", 92, max, input.focus.path, nodes, edges);
  placeColumn(input.dependencies, "it-imports", W - 92, max, input.focus.path, nodes, edges);
  return { nodes, edges };
}

function placeColumn(
  refs: NeighborRef[],
  kind: "imports-it" | "it-imports",
  x: number,
  max: number,
  focusPath: string,
  nodes: ImpactNode[],
  edges: ImpactEdge[],
): void {
  const sorted = [...refs].sort(rank);
  const shown = sorted.slice(0, max);
  const hidden = sorted.length - shown.length;
  const slots = shown.length + (hidden > 0 ? 1 : 0);
  const step = slots > 1 ? (BOTTOM - TOP) / (slots - 1) : 0;

  shown.forEach((r, i) => {
    nodes.push({
      path: r.path,
      kind,
      x,
      y: slots > 1 ? TOP + step * i : H / 2,
      label: r.label,
      meta: r.hasTests ? "" : "no tests",
      hasTests: r.hasTests,
      edits: 0,
      reachedByEdit: r.reachedByEdit,
    });
    edges.push(edge(kind, r.path, focusPath, r.cyclic));
  });

  if (hidden > 0) {
    const id = `more:${kind}`;
    nodes.push({
      path: id,
      kind: "more",
      x,
      y: slots > 1 ? TOP + step * shown.length : H / 2,
      label: `+${hidden} more`,
      meta: "",
      hasTests: true,
      edits: 0,
      reachedByEdit: false,
    });
    edges.push(edge(kind, id, focusPath, false));
  }
}

function edge(
  kind: "imports-it" | "it-imports",
  neighbor: string,
  focus: string,
  cyclic: boolean,
): ImpactEdge {
  // A dependent imports the focus (neighbor → focus); the focus imports a dependency.
  return kind === "imports-it"
    ? { from: neighbor, to: focus, kind, cyclic }
    : { from: focus, to: neighbor, kind, cyclic };
}

function rank(a: NeighborRef, b: NeighborRef): number {
  if (a.reachedByEdit !== b.reachedByEdit) return a.reachedByEdit ? -1 : 1;
  return a.label.localeCompare(b.label);
}
