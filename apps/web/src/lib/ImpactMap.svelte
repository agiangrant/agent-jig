<script lang="ts">
import type { ImpactMap } from "@agent-jig/contracts";

// The focused-file dependency neighborhood (a projection of the codebase graph,
// computed server-side by @agent-jig/codegraph). Node positions arrive already
// laid out in a 600x400 space; we render edges in one SVG and nodes as absolutely
// positioned cards over it, matching the Architecture design.
const {
  map,
  loading = false,
  onSelect,
  onInstall,
}: {
  map: ImpactMap | null;
  loading?: boolean;
  onSelect: (path: string) => void;
  onInstall: (serverId: string) => void;
} = $props();

const VW = 600;
const VH = 400;

// Edge endpoints, resolved from node paths to coordinates.
const lines = $derived.by(() => {
  if (!map) return [];
  const at = new Map(map.nodes.map((n) => [n.path, n]));
  return map.edges.flatMap((e) => {
    const a = at.get(e.from);
    const b = at.get(e.to);
    return a && b ? [{ x1: a.x, y1: a.y, x2: b.x, y2: b.y, kind: e.kind, cyclic: e.cyclic }] : [];
  });
});

function pct(v: number, span: number): string {
  return `${(v / span) * 100}%`;
}
function colorFor(kind: string): string {
  if (kind === "editing") return "var(--warm)";
  if (kind === "imports-it") return "var(--accent)";
  return "var(--text-3)";
}
</script>

<div class="impact">
  <div class="impact-head">
    <div class="impact-title">Impact map</div>
    <div class="legend">
      <span><i style="background:var(--warm)"></i>editing</span>
      <span><i style="background:var(--accent)"></i>imports it</span>
      <span><i style="background:var(--text-3)"></i>it imports</span>
    </div>
  </div>

  {#if loading && !map}
    <div class="impact-empty">Analyzing dependencies…</div>
  {:else if !map}
    <div class="impact-empty">Select a touched file to see what its changes ripple to.</div>
  {:else}
    <p class="ripple">
      Changes to <code>{map.focus.split("/").pop()}</code>
      {#if map.rippleCount > 0}
        ripple to <strong>{map.rippleCount} dependent{map.rippleCount > 1 ? "s" : ""}</strong>.
      {:else}
        have no detected dependents yet.
      {/if}
      {#if map.degraded}
        <span class="degraded">
          No language server — “it imports” resolves local paths only.
          {#if map.install}
            <button class="rail-link" onclick={() => onInstall(map.install!.serverId)} disabled={map.install.installing}>
              {map.install.installing ? "Installing…" : `Install ${map.install.languageId} server`}
            </button>
          {/if}
        </span>
      {/if}
    </p>

    <div class="canvas">
      <svg viewBox="0 0 {VW} {VH}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        {#each lines as l, i (i)}
          <line
            x1={l.x1}
            y1={l.y1}
            x2={l.x2}
            y2={l.y2}
            stroke={colorFor(l.kind)}
            stroke-width="1.5"
            stroke-dasharray={l.kind === "it-imports" ? "4 4" : l.cyclic ? "2 3" : "0"}
            opacity={l.cyclic ? "0.35" : "0.5"}
          />
        {/each}
      </svg>

      {#each map.nodes as n (n.path)}
        <button
          class="node {n.kind}"
          class:ripple-hit={n.reachedByEdit}
          style="left:{pct(n.x, VW)}; top:{pct(n.y, VH)}; --node-col:{colorFor(n.kind)}"
          disabled={n.kind === "editing" || n.kind === "more"}
          title={n.path}
          onclick={() => onSelect(n.path)}
        >
          <span class="node-name">{n.label}</span>
          {#if n.meta}<span class="node-meta" class:warn={!n.hasTests}>{n.meta}</span>{/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
.impact {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  padding: var(--pad);
  gap: 8px;
}
.impact-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.impact-title {
  font-size: var(--fs-lg);
  font-weight: 600;
  color: var(--text);
}
.legend {
  display: flex;
  gap: 14px;
  font-size: var(--fs-xs);
  color: var(--text-2);
}
.legend span {
  display: flex;
  align-items: center;
  gap: 6px;
}
.legend i {
  width: 9px;
  height: 9px;
  border-radius: 3px;
  display: inline-block;
}
.ripple {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-2);
  line-height: var(--leading);
}
.ripple code {
  font-family: var(--code-font);
  color: var(--warm);
}
.ripple strong {
  color: var(--text);
}
.degraded {
  display: block;
  margin-top: 4px;
  color: var(--warm);
}
.rail-link {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font: inherit;
  padding: 0 0 0 4px;
}
.rail-link:disabled {
  color: var(--text-3);
  cursor: default;
}
.impact-empty {
  flex: 1;
  display: grid;
  place-items: center;
  color: var(--text-3);
  font-size: var(--fs-sm);
}
.canvas {
  position: relative;
  flex: 1;
  min-height: 360px;
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.canvas svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.node {
  position: absolute;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 92px;
  padding: 6px 11px;
  background: var(--panel);
  border: 1.5px solid color-mix(in srgb, var(--node-col) 55%, var(--border));
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-align: left;
  font: inherit;
  box-shadow: var(--shadow);
}
.node:disabled {
  cursor: default;
}
.node.editing {
  border-width: 2px;
}
.node.ripple-hit {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 50%, transparent);
}
.node-name {
  font-family: var(--code-font);
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--node-col);
}
.node-meta {
  font-size: 10px;
  color: var(--text-3);
}
.node-meta.warn {
  color: var(--warm);
}
</style>
