<script lang="ts">
import Code from "./Code.svelte";
import { type Hunk, toHunks } from "./diff.ts";
import { diffMode } from "./diffMode.svelte.ts";

let { toolName, payload }: { toolName: string; payload: unknown } = $props();

const p = $derived(
  (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>,
);
const filePath = $derived(typeof p.file_path === "string" ? p.file_path : "");
const isWrite = $derived(toolName === "Write");
const writeContent = $derived(typeof p.content === "string" ? p.content : "");
const hunks: Hunk[] = $derived(toHunks(toolName, payload));
</script>

{#if isWrite}
  <div class="block plain">
    <Code code={writeContent} path={filePath} numbered={diffMode.lineNumbers} />
  </div>
{:else if hunks.length > 0}
  <div class="controls">
    <button class="seg" class:on={diffMode.mode === "split"} onclick={() => diffMode.set("split")}>Side-by-side</button>
    <button class="seg" class:on={diffMode.mode === "unified"} onclick={() => diffMode.set("unified")}>Unified</button>
    <button class="seg" class:on={diffMode.mode === "ba"} onclick={() => diffMode.set("ba")}>Before/After</button>
    {#if diffMode.mode === "ba"}
      <button class="seg" class:on={diffMode.side === "before"} onclick={() => (diffMode.side = "before")}>Before</button>
      <button class="seg" class:on={diffMode.side === "after"} onclick={() => (diffMode.side = "after")}>After</button>
    {/if}
  </div>

  <div class="diff">
    {#each hunks as h, i (i)}
      {#if diffMode.mode === "split"}
        <div class="split">
          <div class="pane del">
            {#if h.old.length}<Code code={h.old.join("\n")} path={filePath} numbered={diffMode.lineNumbers} startLine={h.startLine} />{:else}<div class="empty">—</div>{/if}
          </div>
          <div class="pane add">
            {#if h.new.length}<Code code={h.new.join("\n")} path={filePath} numbered={diffMode.lineNumbers} startLine={h.startLine} />{:else}<div class="empty">—</div>{/if}
          </div>
        </div>
      {:else if diffMode.mode === "unified"}
        {#if h.old.length}<div class="block del"><Code code={h.old.join("\n")} path={filePath} numbered={diffMode.lineNumbers} startLine={h.startLine} /></div>{/if}
        {#if h.new.length}<div class="block add"><Code code={h.new.join("\n")} path={filePath} numbered={diffMode.lineNumbers} startLine={h.startLine} /></div>{/if}
      {:else}
        {@const side = diffMode.side === "before" ? h.old : h.new}
        <div class="block {diffMode.side === 'before' ? 'del' : 'add'}">
          <Code code={side.join("\n")} path={filePath} numbered={diffMode.lineNumbers} startLine={h.startLine} />
        </div>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .controls {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: 8px 0 6px;
  }
  .seg {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
    color: var(--muted);
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    padding: 3px 9px;
  }
  .seg.on {
    color: var(--fg);
    border-color: var(--accent);
  }
  .diff,
  .block.plain {
    border: 1px solid var(--line);
    border-radius: 6px;
    overflow: auto;
    max-height: 360px;
    background: var(--bg);
  }
  .block.plain {
    margin-top: 8px;
  }
  .block {
    background: var(--bg);
  }
  .split {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }
  .pane {
    min-width: 0;
    overflow-x: auto;
  }
  .pane.del,
  .block.del {
    background: var(--diff-del-bg, rgba(224, 108, 117, 0.1));
  }
  .pane.add,
  .block.add {
    background: var(--diff-add-bg, rgba(127, 209, 127, 0.1));
  }
  .pane.del {
    border-right: 1px solid var(--line);
  }
  .empty {
    color: var(--muted);
    padding: 8px 10px;
    font-size: 12px;
  }
</style>
