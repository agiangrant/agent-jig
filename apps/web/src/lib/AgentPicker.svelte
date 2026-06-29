<script lang="ts">
import type { AgentProvider, ProvidersInfo } from "@agent-jig/contracts";

interface Props {
  providers: ProvidersInfo | null;
  provider: AgentProvider;
  /** Empty string = the provider's default model. */
  model: string;
  /** Small uppercase label shown above the name (e.g. "Reviewer", "Agent"). */
  label?: string;
  /** Compact pill (for the chat composer). */
  compact?: boolean;
  /** Popover side: below (default) or above (for bottom-anchored composers). */
  placement?: "down" | "up";
  /** Popover horizontal alignment. */
  align?: "left" | "right";
  onpick: (provider: AgentProvider, model: string) => void;
}
const {
  providers,
  provider,
  model,
  label,
  compact = false,
  placement = "down",
  align = "left",
  onpick,
}: Props = $props();

let open = $state(false);
const list = $derived(
  providers?.providers ?? [{ id: "claude" as AgentProvider, label: "Claude", available: true, models: [] }],
);
const providerLabel = $derived(list.find((p) => p.id === provider)?.label ?? provider);
const providerName = $derived(providerLabel.split(" ")[0]);
const display = $derived(`${providerName}${model ? ` · ${model}` : ""}`);

function pick(p: AgentProvider, m: string) {
  onpick(p, m);
  open = false;
}
</script>

<div class="apick" class:compact>
  <button class="pill" onclick={() => (open = !open)} title={label ?? "Agent"}>
    <span class="av">{providerName.slice(0, 1).toUpperCase()}</span>
    <span class="text">
      {#if label && !compact}<span class="lbl">{label}</span>{/if}
      <span class="name">{display}</span>
    </span>
    <svg class="chev" class:open width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" stroke-width="2.2"><path d="M6 9l6 6 6-6" /></svg>
  </button>

  {#if open}
    <button class="scrim" aria-label="Close" onclick={() => (open = false)}></button>
    <div class="popover {placement} {align}">
      <div class="head">{label ?? "Agent"}</div>
      <div class="body gv-scroll">
        {#each list as p (p.id)}
          <div class="group">
            {p.label}{#if p.available === false}<span class="na">not detected</span>{/if}
          </div>
          <button class="model" onclick={() => pick(p.id, "")}>
            <span class="mn muted">provider default</span>
            {#if provider === p.id && !model}<span class="ck">✓</span>{/if}
          </button>
          {#each p.models as m (m)}
            <button class="model" onclick={() => pick(p.id, m)}>
              <span class="mn">{m}</span>
              {#if provider === p.id && model === m}<span class="ck">✓</span>{/if}
            </button>
          {/each}
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .apick { position: relative; display: inline-flex; }
  .pill {
    display: flex; align-items: center; gap: 9px;
    border: 1px solid var(--border); background: var(--bg-2);
    border-radius: 8px; cursor: pointer; font: inherit; padding: 4px 9px 4px 5px;
    color: var(--fg);
  }
  .pill:hover { background: var(--bg-3); }
  .av {
    width: 24px; height: 24px; border-radius: 6px; flex: none;
    background: var(--accent); color: var(--on-accent);
    display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700;
  }
  .text { display: flex; flex-direction: column; align-items: flex-start; line-height: 1.15; min-width: 0; }
  .lbl { font-size: 9px; color: var(--text-3); font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
  .name { font-size: var(--fs-sm); color: var(--fg); font-weight: 600; white-space: nowrap; }
  .chev { transition: transform 0.15s; flex: none; }
  .chev.open { transform: rotate(180deg); }

  /* Compact variant for the composer toolbar. */
  .compact .pill { gap: 6px; padding: 3px 7px 3px 4px; }
  .compact .av { width: 18px; height: 18px; border-radius: 5px; font-size: 9px; }
  .compact .name { font-size: var(--fs-xs); }

  .scrim { position: fixed; inset: 0; z-index: 40; border: 0; background: transparent; cursor: default; }
  .popover {
    position: absolute; width: 280px; z-index: 41;
    background: var(--bg-2); border: 1px solid var(--border);
    border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden;
  }
  .popover.down { top: calc(100% + 6px); }
  .popover.up { bottom: calc(100% + 6px); }
  .popover.left { left: 0; }
  .popover.right { right: 0; }
  .head { padding: var(--pad-sm) var(--pad); border-bottom: 1px solid var(--border-soft); font-size: var(--fs-sm); font-weight: 700; color: var(--fg); }
  .body { max-height: 300px; overflow-y: auto; padding: 6px; }
  .group { padding: 7px 9px 3px; font-size: var(--fs-xs); color: var(--text-2); font-weight: 600; display: flex; align-items: center; gap: 6px; }
  .group .na { color: var(--text-3); font-weight: 500; }
  .model {
    width: 100%; text-align: left; display: flex; align-items: center; gap: 9px;
    border: 0; background: transparent; cursor: pointer; font: inherit;
    border-radius: 6px; padding: 7px 9px 7px 22px;
  }
  .model:hover { background: var(--bg-3); }
  .mn { font-family: var(--code-font); font-size: var(--fs-sm); color: var(--fg); }
  .mn.muted { color: var(--text-3); font-family: var(--ui-font); }
  .ck { margin-left: auto; color: var(--accent); font-weight: 700; }
</style>
