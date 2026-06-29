<script lang="ts">
import type { LineComment } from "@agent-jig/contracts";
import Code from "./Code.svelte";
import { toHunks } from "./diff.ts";
import { diffMode } from "./diffMode.svelte.ts";
import { buildRows, type DiffRow, toSplit } from "./fileDiff.ts";
import { fetchFileSlice } from "./files.ts";
import { getHighlighter, langFromPath } from "./highlight.ts";
import { theme } from "./theme.svelte.ts";

/** A new comment before it's assigned an id/editId/path (those come from the caller). */
type NewComment = Pick<LineComment, "side" | "line" | "lineText" | "body">;

let {
  toolName,
  payload,
  path,
  base,
  sessionId,
  comments = [],
  onAddComment,
  onRemoveComment,
}: {
  toolName: string;
  payload: unknown;
  path: string;
  base: string;
  sessionId: string;
  /** Line comments already pinned to this edit (filtered by the caller). */
  comments?: LineComment[];
  /** Pin a new line comment. When absent, the diff is read-only (no gutter). */
  onAddComment?: (c: NewComment) => void;
  /** Remove a pinned comment by id. */
  onRemoveComment?: (id: string) => void;
} = $props();

/** Commenting is on only when the caller wired up an add handler. */
const commentable = $derived(onAddComment != null);

// Lines of context to load around each hunk on first render.
const CTX = 8;

const hunks = $derived(toHunks(toolName, payload));
const isWrite = $derived(toolName === "Write");
const writeContent = $derived(
  ((payload && typeof payload === "object" ? payload : {}) as { content?: string }).content ?? "",
);
const writeLines = $derived(isWrite ? writeContent.split("\n") : []);

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
  // A Write renders the whole new file; tokenize it in one pass and key the
  // per-line tokens by text so renderLine can syntax-color each commentable line.
  const fullContent = isWrite ? writeContent : null;
  let cancelled = false;
  void (async () => {
    try {
      const hl = await getHighlighter();
      const useLang = hl.getLoadedLanguages().includes(wanted) ? wanted : "text";
      const useTheme = hl.getLoadedThemes().includes(themeName) ? themeName : "one-dark-pro";
      const map = new Map<string, Token[]>();
      const toToken = (t: { content: string; color?: string }) => ({
        content: t.content,
        color: t.color ?? "var(--fg)",
      });
      if (fullContent !== null) {
        const { tokens } = hl.codeToTokens(fullContent, { lang: useLang, theme: useTheme });
        fullContent.split("\n").forEach((text, i) => {
          if (!map.has(text)) map.set(text, (tokens[i] ?? []).map(toToken));
        });
      } else {
        for (const text of texts) {
          const { tokens } = hl.codeToTokens(text, { lang: useLang, theme: useTheme });
          map.set(text, (tokens[0] ?? []).map(toToken));
        }
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

// --- Line comments ---------------------------------------------------------
// The composer that's currently open (one at a time), anchored to a diff line.
type Anchor = { side: "old" | "new"; line: number; lineText: string };
let composerAt = $state<Anchor | null>(null);
let draft = $state("");

const commentsFor = (side: "old" | "new", line: number): LineComment[] =>
  comments.filter((c) => c.side === side && c.line === line);

const isOpen = (side: "old" | "new", line: number): boolean =>
  composerAt?.side === side && composerAt?.line === line;

/** Does this (side,line) have comments or an open composer? Drives the block. */
const hasBlock = (side: "old" | "new", line: number | null): boolean =>
  line != null && (commentsFor(side, line).length > 0 || isOpen(side, line));

function openComposer(side: "old" | "new", line: number, lineText: string): void {
  composerAt = { side, line, lineText };
  draft = "";
}

function cancelComposer(): void {
  composerAt = null;
  draft = "";
}

function saveComment(): void {
  const a = composerAt;
  const body = draft.trim();
  if (a === null || body === "") return;
  onAddComment?.({ side: a.side, line: a.line, lineText: a.lineText, body });
  cancelComposer();
}

function composerKey(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.preventDefault();
    cancelComposer();
  } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    saveComment();
  }
}

/** Focus the composer textarea when it mounts. */
function autofocus(node: HTMLTextAreaElement): void {
  node.focus();
}
</script>

<div class="fd gv-scroll" bind:this={bodyEl}>
  {#if error}
    <div class="fd-error">Couldn't load file context: {error}</div>
  {/if}

  {#snippet addBtn(side: "old" | "new", line: number, lineText: string)}
    {#if commentable}
      <button
        class="add-cmt"
        title="Comment on this line"
        aria-label="Comment on line {line}"
        onclick={() => openComposer(side, line, lineText)}>+</button>
    {/if}
  {/snippet}

  {#snippet block(side: "old" | "new", line: number | null)}
    {#if commentable && line != null && hasBlock(side, line)}
      <div class="cmt-block">
        {#each commentsFor(side, line) as c (c.id)}
          <div class="cmt-card">
            <span class="cmt-loc">L{c.line}</span>
            <span class="cmt-body">{c.body}</span>
            <button class="cmt-x" aria-label="Remove comment" onclick={() => onRemoveComment?.(c.id)}
              >✕</button>
          </div>
        {/each}
        {#if isOpen(side, line)}
          <div class="cmt-composer">
            <textarea
              use:autofocus
              bind:value={draft}
              placeholder="Comment on line {line}…  (⌘/Ctrl+Enter to add)"
              onkeydown={composerKey}></textarea>
            <div class="cmt-actions">
              <button class="cmt-cancel" onclick={cancelComposer}>Cancel</button>
              <button class="cmt-save" disabled={draft.trim() === ""} onclick={saveComment}>
                Comment
              </button>
            </div>
          </div>
        {/if}
      </div>
    {/if}
  {/snippet}

  {#if isWrite && !commentable}
    <div class="fd-write">
      <Code code={writeContent} {path} numbered={numbers} />
    </div>
  {:else if isWrite}
    <!-- Commentable Write: render the full new file line-by-line so each line
         carries a gutter + comment block (Code.svelte stays read-only elsewhere). -->
    <div class="rows mono uni">
      {#each writeLines as text, idx (idx)}
        {@const line = idx + 1}
        <div class="urow" class:commentable>
          {@render addBtn("new", line, text)}
          {#if numbers}<span class="num">{line}</span>{/if}
          <span class="src">{@html renderLine(text)}</span>
        </div>
        {@render block("new", line)}
      {/each}
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
            <div class="cell {r.l.type}" class:commentable class:whole={r.l.type !== "ctx" && r.l.type !== "blank" && !r.l.emph}>
              {#if r.l.type !== "blank" && r.l.num != null}{@render addBtn("old", r.l.num, r.l.text)}{/if}
              {#if numbers}<span class="num">{r.l.num ?? ""}</span>{/if}
              <span class="src">{@html r.l.type === "blank" ? "" : renderLine(r.l.text, r.l.emph)}</span>
            </div>
            <div class="cell {r.r.type}" class:commentable class:whole={r.r.type !== "ctx" && r.r.type !== "blank" && !r.r.emph}>
              {#if r.r.type !== "blank" && r.r.num != null}{@render addBtn("new", r.r.num, r.r.text)}{/if}
              {#if numbers}<span class="num">{r.r.num ?? ""}</span>{/if}
              <span class="src">{@html r.r.type === "blank" ? "" : renderLine(r.r.text, r.r.emph)}</span>
            </div>
          </div>
          {@render block("old", r.l.type === "blank" ? null : r.l.num)}
          {@render block("new", r.r.type === "blank" ? null : r.r.num)}
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
          {@const side = r.type === "del" ? "old" : "new"}
          {@const lineNo = r.type === "del" ? r.oldNo : r.newNo}
          <div class="urow {r.type}" class:commentable class:whole={r.type !== "ctx" && !r.emph} data-hunk={r.hunk ?? ""}>
            {#if lineNo != null}{@render addBtn(side, lineNo, r.text)}{/if}
            {#if numbers}<span class="num">{r.oldNo ?? ""}</span><span class="num">{r.newNo ?? ""}</span>{/if}
            <span class="sig">{r.type === "add" ? "+" : r.type === "del" ? "−" : " "}</span>
            <span class="src">{@html renderLine(r.text, r.emph)}</span>
          </div>
          {@render block(side, lineNo)}
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

  /* --- Line comments --- */
  /* A narrow gutter button revealed on row/cell hover (GitHub-style). */
  .add-cmt {
    flex: none;
    width: 1.5em;
    margin-right: -0.1em;
    border: none;
    background: transparent;
    color: var(--accent);
    font: inherit;
    font-weight: 700;
    line-height: 1.6;
    text-align: center;
    cursor: pointer;
    padding: 0;
    opacity: 0;
    user-select: none;
    transition: opacity 0.08s;
  }
  /* Reserve the gutter on commentable rows so revealing the button never shifts text. */
  .urow.commentable:not(:hover) .add-cmt,
  .cell.commentable:not(:hover) .add-cmt {
    opacity: 0;
  }
  .urow.commentable:hover > .add-cmt,
  .cell.commentable:hover > .add-cmt {
    opacity: 0.6;
  }
  .add-cmt:hover {
    opacity: 1;
  }
  /* Keep a placeholder gutter when no button renders (blank split cells), so the
     two cells stay aligned. */
  .cell.commentable > .num:first-child {
    margin-left: 1.4em;
  }

  .cmt-block {
    position: sticky;
    left: 0;
    box-sizing: border-box;
    width: min(680px, 100%);
    white-space: normal;
    padding: 6px 10px 8px 3.4em;
    background: var(--panel);
    border-left: 2px solid var(--accent);
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-family: var(--ui-font);
  }
  .cmt-card {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 5px 8px;
    font-size: 12px;
  }
  .cmt-loc {
    flex: none;
    color: var(--accent);
    font-family: var(--code-font);
    opacity: 0.85;
  }
  .cmt-body {
    flex: 1;
    color: var(--fg);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .cmt-x {
    flex: none;
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    font-size: 11px;
    line-height: 1.4;
    padding: 0 2px;
  }
  .cmt-x:hover {
    color: var(--danger);
  }
  .cmt-composer {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .cmt-composer textarea {
    width: 100%;
    box-sizing: border-box;
    min-height: 52px;
    resize: vertical;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--bg);
    color: var(--fg);
    font-family: var(--ui-font);
    font-size: 12px;
    padding: 6px 8px;
  }
  .cmt-composer textarea:focus {
    outline: none;
    border-color: var(--accent);
  }
  .cmt-actions {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
  }
  .cmt-actions button {
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--panel);
    color: var(--fg);
    font: inherit;
    font-size: 12px;
    padding: 3px 12px;
    cursor: pointer;
  }
  .cmt-save {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--bg);
    font-weight: 600;
  }
  .cmt-save:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
