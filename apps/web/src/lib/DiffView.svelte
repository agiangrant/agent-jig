<script lang="ts">
  import { type Hunk, toHunks } from "./diff.ts";

  let { toolName, payload }: { toolName: string; payload: unknown } = $props();
  const hunks: Hunk[] = $derived(toHunks(toolName, payload));
</script>

{#if hunks.length > 0}
  <div class="diff">
    {#each hunks as h, i (i)}
      {#each h.old as line, j (`o${i}-${j}`)}
        <div class="ln del">- {line}</div>
      {/each}
      {#each h.new as line, j (`n${i}-${j}`)}
        <div class="ln add">+ {line}</div>
      {/each}
    {/each}
  </div>
{/if}

<style>
  .diff {
    margin-top: 8px;
    border: 1px solid var(--line);
    border-radius: 6px;
    overflow: auto;
    max-height: 320px;
    background: #0f1015;
  }
  .ln {
    white-space: pre;
    padding: 0 10px;
    font-size: 12px;
    line-height: 1.45;
  }
  .del {
    color: #e06c75;
    background: rgba(224, 108, 117, 0.08);
  }
  .add {
    color: #7fd17f;
    background: rgba(127, 209, 127, 0.08);
  }
</style>
