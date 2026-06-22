<script lang="ts">
import Code from "./Code.svelte";
import { toHunks } from "./diff.ts";
import { diffMode } from "./diffMode.svelte.ts";
import { buildRows, type DiffRow, toSplit } from "./fileDiff.ts";
import { fetchFileSlice } from "./files.ts";
import { getHighlighter, langFromPath } from "./highlight.ts";
import { theme } from "./theme.svelte.ts";

let {
  toolName,
  payload,
  path,
  base,
  sessionId,
}: {
  toolName: string;
  payload: unknown;
  path: string;
  base: string;
  sessionId: string;
} = $props();

// Lines of context to load around each hunk on first render.
const CTX = 8;

const hunks = $derived(toHunks(toolName, payload));
const isWrite = $derived(toolName === "Write");
const writeContent = $derived(
  ((payload && typeof payload === "object" ? payload : {}) as { content?: string }).content ?? "",
);

let fetched = $state(new Map<number, string>());
let totalLines = $state(0);
let loadingFull = $state(false);
let error = $state<string | null>(null);

const rows = $derived(buildRows(hunks, fetched, totalLines));
const splitRows = $derived(toSplit(rows));

let bodyEl: HTMLDivElement;

async function load(from: number, to: number, full = false): Promise<void> {
  try {
    const slice = await fetchFileSlice(base, sessionId, path, full ? { full } : { from, to });
    totalLines = slice.totalLines;
    const next = new Map(fetched);
    slice.lines.forEach((t, i) => {
      next.set(slice.from + i, t);
    });
    fetched = next;
  } catch (e) {
    error = (e as Error).message;
  }
}

// Initial load: a context window around every hunk. New files (Write) have no
// on-disk old content to expand, so they render their full new content instead.
$effect(() => {
  if (isWrite || hunks.length === 0 || !sessionId) return;
  const ranges = hunks.map((h) => [
    Math.max(1, h.startLine - CTX),
    h.startLine + h.old.length - 1 + CTX,
  ]);
  void Promise.all(ranges.map(([f, t]) => load(f, t)));
});

async function expand(from: number, to: number): Promise<void> {
  await load(from, to);
}

async function viewFull(): Promise<void> {
  loadingFull = true;
  await load(1, totalLines, true);
  loadingFull = false;
}

const fullyExpanded = $derived(totalLines > 0 && fetched.size >= totalLines);

// Per-line Shiki tokens, keyed by text so unified + split share them. We keep the
// tokens (not prebuilt HTML) so the renderer can overlay word-level change
// highlights on top of syntax colors, splitting tokens at the changed char ranges.
type Token = { content: string; color: string };
let tokensByText = $state(new Map<string, Token[]>());

const escapeHtml = (s: string): string =>
  s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));

$effect(() => {
  const themeName = theme.current;
  const wanted = langFromPath(path);
  const texts = new Set<string>();
  for (const r of rows) if (r.kind === "line") texts.add(r.text);
  let cancelled = false;
  void (async () => {
    try {
      const hl = await getHighlighter();
      const useLang = hl.getLoadedLanguages().includes(wanted) ? wanted : "text";
      const useTheme = hl.getLoadedThemes().includes(themeName) ? themeName : "one-dark-pro";
      const map = new Map<string, Token[]>();
      for (const text of texts) {
        const { tokens } = hl.codeToTokens(text, { lang: useLang, theme: useTheme });
        map.set(
          text,
          (tokens[0] ?? []).map((t) => ({ content: t.content, color: t.color ?? "var(--fg)" })),
        );
      }
      if (!cancelled) tokensByText = map;
    } catch {
      /* fall back to plain text below */
    }
  })();
  return () => {
    cancelled = true;
  };
});

/**
 * Render one line as colored spans, wrapping the changed char ranges (`emph`) in
 * a strongly-tinted span. Tokens are split at range boundaries so syntax color
 * and change-highlight compose cleanly (GitHub-style intra-line diff).
 */
function renderLine(text: string, emph?: ReadonlyArray<readonly [number, number]>): string {
  const tokens = tokensByText.get(text) ?? [{ content: text, color: "var(--fg)" }];
  const ranges = emph ?? [];
  const inRange = (p: number) => ranges.some(([s, e]) => p >= s && p < e);
  let html = "";
  let pos = 0;
  for (const tk of tokens) {
    const tEnd = pos + tk.content.length;
    let cur = pos;
    while (cur < tEnd) {
      const on = inRange(cur);
      // Extend the segment until the emph state flips or the token ends.
      let segEnd = cur + 1;
      while (segEnd < tEnd && inRange(segEnd) === on) segEnd++;
      const piece = tk.content.slice(cur - pos, segEnd - pos);
      html += `<span style="color:${tk.color}"${on ? ' class="emph"' : ""}>${escapeHtml(piece)}</span>`;
      cur = segEnd;
    }
    pos = tEnd;
  }
  return html;
}

const numbers = $derived(diffMode.lineNumbers);
const split = $derived(diffMode.mode === "split");

/** Scroll to the next/previous change run. Called from the surface footer. */
export function scrollToChange(dir: 1 | -1): void {
  if (!bodyEl) return;
  const nodes = Array.from(bodyEl.querySelectorAll<HTMLElement>("[data-hunk]"));
  if (nodes.length === 0) return;
  const top = bodyEl.scrollTop;
  const target =
    dir > 0
      ? (nodes.find((n) => n.offsetTop > top + 6) ?? nodes[0])
      : ([...nodes].reverse().find((n) => n.offsetTop < top - 6) ?? nodes[nodes.length - 1]);
  if (target) bodyEl.scrollTo({ top: Math.max(0, target.offsetTop - 60), behavior: "smooth" });
}
</script>

<div class="fd gv-scroll" bind:this={bodyEl}>
  {#if error}
    <div class="fd-error">Couldn't load file context: {error}</div>
  {/if}

  {#if isWrite}
    <div class="fd-write">
      <Code code={writeContent} {path} numbered={numbers} />
    </div>
  {:else if split}
    <div class="rows mono spl">
      {#each splitRows as r, i (i)}
        {#if r.kind === "fold"}
          <button class="fold" onclick={() => expand(r.from, r.to)}>
            ⇕ Expand {r.count} unchanged line{r.count > 1 ? "s" : ""}
          </button>
        {:else}
          <div class="srow" data-hunk={r.hunk ?? ""}>
            <div class="cell {r.l.type}" class:whole={r.l.type !== "ctx" && r.l.type !== "blank" && !r.l.emph}>
              {#if numbers}<span class="num">{r.l.num ?? ""}</span>{/if}
              <span class="src">{@html r.l.type === "blank" ? "" : renderLine(r.l.text, r.l.emph)}</span>
            </div>
            <div class="cell {r.r.type}" class:whole={r.r.type !== "ctx" && r.r.type !== "blank" && !r.r.emph}>
              {#if numbers}<span class="num">{r.r.num ?? ""}</span>{/if}
              <span class="src">{@html r.r.type === "blank" ? "" : renderLine(r.r.text, r.r.emph)}</span>
            </div>
          </div>
        {/if}
      {/each}
    </div>
  {:else}
    <div class="rows mono uni">
      {#each rows as r, i (i)}
        {#if r.kind === "fold"}
          <button class="fold" onclick={() => expand(r.from, r.to)}>
            ⇕ Expand {r.count} unchanged line{r.count > 1 ? "s" : ""}
          </button>
        {:else}
          <div class="urow {r.type}" class:whole={r.type !== "ctx" && !r.emph} data-hunk={r.hunk ?? ""}>
            {#if numbers}<span class="num">{r.oldNo ?? ""}</span><span class="num">{r.newNo ?? ""}</span>{/if}
            <span class="sig">{r.type === "add" ? "+" : r.type === "del" ? "−" : " "}</span>
            <span class="src">{@html renderLine(r.text, r.emph)}</span>
          </div>
        {/if}
      {/each}
    </div>
  {/if}

  {#if !isWrite && totalLines > 0 && !fullyExpanded}
    <button class="view-full" onclick={viewFull} disabled={loadingFull}>
      {loadingFull ? "Loading…" : "View full file"}
    </button>
  {/if}
</div>

<style>
  .fd {
    flex: 1;
    min-height: 0;
    overflow: auto;
    background: var(--bg);
  }
  .mono {
    font-family: var(--code-font);
    font-size: var(--code-font-size);
    line-height: 1.6;
    padding-bottom: 18px;
  }
  /* Unified: size to the longest line so each row's tint spans the full width
     (not just the viewport) when scrolled horizontally. */
  .uni {
    width: max-content;
    min-width: 100%;
  }
  .urow {
    display: flex;
    width: 100%;
    border-left: 2px solid transparent;
    white-space: pre;
  }
  /* Modified lines use a faded base tint; the changed words (.emph) and whole
     pure add/del lines (.whole) get a stronger one. */
  .urow.add {
    background: var(--diff-add-bg, rgba(127, 209, 127, 0.1));
    border-left-color: var(--ok, #4fd6a0);
  }
  .urow.del {
    background: var(--diff-del-bg, rgba(224, 108, 117, 0.1));
    border-left-color: var(--danger, #f1726a);
  }
  .urow.add.whole {
    background: color-mix(in srgb, var(--ok, #4fd6a0) 20%, transparent);
  }
  .urow.del.whole {
    background: color-mix(in srgb, var(--danger, #f1726a) 18%, transparent);
  }
  .urow.add :global(.emph) {
    background: color-mix(in srgb, var(--ok, #4fd6a0) 42%, transparent);
    border-radius: 2px;
  }
  .urow.del :global(.emph) {
    background: color-mix(in srgb, var(--danger, #f1726a) 40%, transparent);
    border-radius: 2px;
  }
  .num {
    flex: none;
    width: 2.8em;
    text-align: right;
    padding-right: 10px;
    color: var(--muted);
    opacity: 0.55;
    user-select: none;
  }
  .sig {
    flex: none;
    width: 1.2em;
    text-align: center;
    user-select: none;
    color: var(--muted);
  }
  .urow.add .sig {
    color: var(--ok, #4fd6a0);
  }
  .urow.del .sig {
    color: var(--danger, #f1726a);
  }
  .src {
    white-space: pre;
    padding-right: 14px;
  }
  /* split */
  .srow {
    display: flex;
  }
  .cell {
    flex: 1;
    min-width: 0;
    display: flex;
    border-left: 2px solid transparent;
    overflow: hidden;
  }
  .cell:first-child {
    border-right: 1px solid var(--line);
  }
  .cell.add {
    background: var(--diff-add-bg, rgba(127, 209, 127, 0.1));
    border-left-color: var(--ok, #4fd6a0);
  }
  .cell.del {
    background: var(--diff-del-bg, rgba(224, 108, 117, 0.1));
    border-left-color: var(--danger, #f1726a);
  }
  .cell.add.whole {
    background: color-mix(in srgb, var(--ok, #4fd6a0) 20%, transparent);
  }
  .cell.del.whole {
    background: color-mix(in srgb, var(--danger, #f1726a) 18%, transparent);
  }
  .cell.add :global(.emph) {
    background: color-mix(in srgb, var(--ok, #4fd6a0) 42%, transparent);
    border-radius: 2px;
  }
  .cell.del :global(.emph) {
    background: color-mix(in srgb, var(--danger, #f1726a) 40%, transparent);
    border-radius: 2px;
  }
  .fold {
    width: 100%;
    text-align: left;
    border: none;
    border-top: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
    background: var(--panel);
    color: var(--muted);
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    padding: 4px 16px;
  }
  .fold:hover {
    color: var(--fg);
    background: var(--bg);
  }
  .view-full {
    display: block;
    margin: 10px auto 16px;
    border: 1px solid var(--line);
    background: var(--panel);
    color: var(--fg);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    border-radius: 6px;
    padding: 6px 14px;
  }
  .view-full:hover {
    border-color: var(--accent);
  }
  .fd-error {
    color: var(--danger);
    font-size: 12px;
    padding: 8px 16px;
  }
  .fd-write {
    padding: 4px 0;
  }
</style>
