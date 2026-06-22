<script lang="ts">
import Code from "./Code.svelte";
import { diffMode } from "./diffMode.svelte.ts";
import { fetchFileSlice } from "./files.ts";

let {
  path,
  base,
  sessionId,
  onClose,
}: {
  path: string;
  base: string;
  sessionId: string;
  onClose: () => void;
} = $props();

let content = $state("");
let error = $state<string | null>(null);
let loading = $state(true);

// Re-fetch whenever the previewed file changes.
$effect(() => {
  const p = path;
  loading = true;
  error = null;
  let cancelled = false;
  void (async () => {
    try {
      const slice = await fetchFileSlice(base, sessionId, p, { full: true });
      if (!cancelled) content = slice.lines.join("\n");
    } catch (e) {
      if (!cancelled) error = (e as Error).message;
    } finally {
      if (!cancelled) loading = false;
    }
  })();
  return () => {
    cancelled = true;
  };
});
</script>

<div class="preview">
  <div class="pv-head">
    <span class="pv-tag">Preview</span>
    <code class="pv-path">{path}</code>
    <button class="pv-close" onclick={onClose} title="Back to review">✕</button>
  </div>
  <div class="pv-body gv-scroll">
    {#if loading}
      <p class="pv-msg">Loading {path}…</p>
    {:else if error}
      <p class="pv-msg err">Couldn't load file: {error}</p>
    {:else}
      <Code code={content} {path} numbered={diffMode.lineNumbers} />
    {/if}
  </div>
</div>

<style>
  .preview {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }
  .pv-head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: var(--pad-sm) var(--pad);
    border-bottom: 1px solid var(--border-soft);
    background: var(--bg-1);
  }
  .pv-tag {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--accent);
  }
  .pv-path {
    font-family: var(--code-font);
    font-size: 12px;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pv-close {
    margin-left: auto;
    border: 1px solid var(--line);
    background: var(--panel);
    color: var(--muted);
    cursor: pointer;
    font: inherit;
    border-radius: 6px;
    width: 26px;
    height: 26px;
  }
  .pv-close:hover {
    color: var(--fg);
    border-color: var(--accent);
  }
  .pv-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .pv-msg {
    color: var(--muted);
    padding: 16px;
    font-size: 13px;
  }
  .pv-msg.err {
    color: var(--danger);
  }
</style>
