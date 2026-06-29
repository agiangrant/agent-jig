<script lang="ts">
import { renderMarkdown } from "./markdown.ts";

interface Props {
  text: string;
}
const { text }: Props = $props();
const html = $derived(renderMarkdown(text));
</script>

<!-- Content is rendered through renderMarkdown, which escapes raw HTML. -->
<div class="md">{@html html}</div>

<style>
  .md {
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .md :global(p) { margin: 0 0 0.5em; }
  .md :global(p:last-child) { margin-bottom: 0; }
  .md :global(ul),
  .md :global(ol) { margin: 0 0 0.5em; padding-left: 1.4em; }
  .md :global(li) { margin: 0.1em 0; }
  .md :global(a) { color: var(--accent); }
  .md :global(code) {
    font-family: var(--code-font);
    font-size: 0.92em;
    background: var(--bg-2);
    border: 1px solid var(--border-soft, var(--border));
    border-radius: 4px;
    padding: 0.05em 0.35em;
  }
  .md :global(.md-pre) {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: var(--pad-xs) var(--pad-sm);
    overflow-x: auto;
    margin: 0 0 0.5em;
  }
  .md :global(.md-pre code) {
    background: none;
    border: 0;
    padding: 0;
    font-size: var(--code-font-size);
  }
  .md :global(blockquote) {
    margin: 0 0 0.5em;
    padding-left: 0.8em;
    border-left: 3px solid var(--border);
    color: var(--muted);
  }
  .md :global(h1),
  .md :global(h2),
  .md :global(h3) { margin: 0.6em 0 0.3em; font-size: 1.05em; }
  .md :global(pre),
  .md :global(table) { max-width: 100%; }
</style>
