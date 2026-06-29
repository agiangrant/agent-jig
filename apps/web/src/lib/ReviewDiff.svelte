<script lang="ts">
import type { ReviewComment, ReviewDiffRow, ReviewFileDiff } from "@agent-jig/contracts";
import Markdown from "./Markdown.svelte";

interface Props {
  file: ReviewFileDiff;
  comments: ReviewComment[];
  onAdd: (c: { path: string; side: "old" | "new"; line: number; lineText: string; body: string }) => void;
  onResolve: (id: string, resolved: boolean) => void;
  onDismiss: (id: string) => void;
}
const { file, comments, onAdd, onResolve, onDismiss }: Props = $props();

let collapsed = $state(false);

const TAG: Record<ReviewFileDiff["status"], { letter: string; color: string }> = {
  added: { letter: "A", color: "var(--go)" },
  modified: { letter: "M", color: "var(--warm)" },
  deleted: { letter: "D", color: "var(--danger)" },
  renamed: { letter: "R", color: "var(--accent)" },
};

const open = $derived(comments.filter((c) => !c.resolved));
// Worst unresolved severity drives the file's status dot.
const dotColor = $derived(
  open.some((c) => c.severity === "issue")
    ? "var(--danger)"
    : open.some((c) => c.severity === "warning")
      ? "var(--warm)"
      : open.length > 0
        ? "var(--accent)"
        : "var(--text-3)",
);
const adds = $derived(file.hunks.flatMap((h) => h.rows).filter((r) => r.kind === "add").length);
const dels = $derived(file.hunks.flatMap((h) => h.rows).filter((r) => r.kind === "del").length);

function anchor(row: ReviewDiffRow): { side: "old" | "new"; line: number } | null {
  if (row.kind === "del") return row.oldLine === null ? null : { side: "old", line: row.oldLine };
  return row.newLine === null ? null : { side: "new", line: row.newLine };
}
function commentsAt(side: "old" | "new", line: number): ReviewComment[] {
  return comments.filter((c) => c.side === side && c.line === line);
}

const SEV: Record<string, { label: string; color: string; bg: string }> = {
  issue: { label: "must-fix", color: "var(--danger)", bg: "color-mix(in srgb, var(--danger) 16%, transparent)" },
  warning: { label: "suggestion", color: "var(--warm)", bg: "color-mix(in srgb, var(--warm) 16%, transparent)" },
  info: { label: "note", color: "var(--text-2)", bg: "var(--bg-3)" },
};

let composing = $state<string | null>(null);
let draft = $state("");
function openComposer(side: "old" | "new", line: number) {
  composing = `${side}:${line}`;
  draft = "";
}
function save(side: "old" | "new", line: number, lineText: string) {
  const body = draft.trim();
  if (body) onAdd({ path: file.path, side, line, lineText, body });
  composing = null;
  draft = "";
}
const sign = (k: ReviewDiffRow["kind"]) => (k === "add" ? "+" : k === "del" ? "−" : " ");
</script>

<div class="rfile">
  <button class="rbanner" onclick={() => (collapsed = !collapsed)}>
    <svg class="chev" class:open={!collapsed} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M9 6l6 6-6 6" /></svg>
    <span class="dot" style="background:{dotColor}"></span>
    <span class="tag" style="color:{TAG[file.status].color}">{TAG[file.status].letter}</span>
    <code class="path">{file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path}</code>
    {#if open.length > 0}<span class="fcount">{open.length}</span>{/if}
    <span class="delta"><span class="add">+{adds}</span><span class="del">−{dels}</span></span>
  </button>

  {#if !collapsed}
    <div class="rbody">
      {#each file.hunks as hunk (hunk.header)}
        <div class="hunk-head">{hunk.header}</div>
        {#each hunk.rows as row (`${row.oldLine}:${row.newLine}:${row.text}`)}
          {@const a = anchor(row)}
          <div class="row {row.kind}">
            <span class="ln">{(row.kind === "del" ? row.oldLine : row.newLine) ?? ""}</span>
            <span class="sig">{sign(row.kind)}</span>
            <span class="text">{row.text || " "}</span>
            {#if a}<button class="add-cmt" title="Comment" onclick={() => a && openComposer(a.side, a.line)}>+</button>{/if}
          </div>
          {#if a}
            {#each commentsAt(a.side, a.line) as c (c.id)}
              {@const sev = SEV[c.severity] ?? SEV.info}
              <div class="finding" class:resolved={c.resolved} style="--f-acc:{sev.color}">
                <div class="f-head">
                  <span class="f-av">{(c.author === "human" ? "you" : c.author).slice(0, 1).toUpperCase()}</span>
                  {#if c.author !== "human"}
                    <span class="f-sev" style="color:{sev.color};background:{sev.bg}">{sev.label}</span>
                  {/if}
                  <span class="f-who">{c.author === "human" ? "you" : c.author}{c.model ? ` · ${c.model}` : ""}</span>
                  <div class="f-actions">
                    <button onclick={() => onResolve(c.id, !c.resolved)}>{c.resolved ? "Reopen" : "Resolve"}</button>
                    <button class="dismiss" onclick={() => onDismiss(c.id)}>Dismiss</button>
                  </div>
                </div>
                <div class="f-body"><Markdown text={c.body} /></div>
              </div>
            {/each}
            {#if composing === `${a.side}:${a.line}`}
              <div class="composer">
                <textarea
                  bind:value={draft}
                  placeholder="Leave a comment…"
                  onkeydown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") a && save(a.side, a.line, row.text);
                    if (e.key === "Escape") composing = null;
                  }}
                ></textarea>
                <div class="composer-actions">
                  <button onclick={() => (composing = null)}>Cancel</button>
                  <button class="primary" onclick={() => a && save(a.side, a.line, row.text)}>Comment</button>
                </div>
              </div>
            {/if}
          {/if}
        {/each}
      {/each}
    </div>
  {/if}
</div>

<style>
  .rfile {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
    margin-bottom: var(--gap-sm);
    background: var(--bg-1);
  }
  .rbanner {
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    padding: var(--pad-xs) var(--pad-sm);
    background: var(--bg-2);
    border: 0;
    border-bottom: 1px solid var(--border-soft);
    cursor: pointer;
    font: inherit;
    color: var(--fg);
    text-align: left;
  }
  .rbanner:hover { background: var(--bg-3); }
  .chev { color: var(--text-3); flex: none; transition: transform 0.15s ease; }
  .chev.open { transform: rotate(90deg); }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  .tag { width: 14px; text-align: center; font-size: 10px; font-weight: 700; flex: none; }
  .path {
    font-family: var(--code-font);
    font-size: var(--fs-sm);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fcount {
    font-size: 9px;
    font-weight: 700;
    color: #fff;
    background: var(--danger);
    border-radius: 999px;
    padding: 1px 6px;
    flex: none;
  }
  .delta { display: flex; gap: 7px; font-family: var(--code-font); font-size: var(--fs-xs); font-weight: 600; flex: none; }
  .delta .add { color: var(--go); }
  .delta .del { color: var(--danger); }

  .rbody { font-family: var(--code-font); font-size: var(--code-font-size); line-height: 1.65; }
  .hunk-head { padding: 3px var(--pad-sm); color: var(--text-3); background: var(--bg-2); white-space: pre; }
  .row {
    display: grid;
    grid-template-columns: 3.4em 1.1em 1fr auto;
    align-items: start;
    white-space: pre-wrap;
    word-break: break-word;
    position: relative;
    border-left: 2px solid transparent;
  }
  .row.add { background: color-mix(in srgb, var(--go) 11%, transparent); border-left-color: var(--go); }
  .row.del { background: color-mix(in srgb, var(--danger) 11%, transparent); border-left-color: var(--danger); }
  .ln { text-align: right; padding-right: 8px; color: var(--text-3); opacity: 0.6; user-select: none; }
  .sig { text-align: center; user-select: none; }
  .row.add .sig { color: var(--go); }
  .row.del .sig { color: var(--danger); }
  .text { padding-right: 1.6em; color: var(--text-2); }
  .row.add .text, .row.del .text { color: var(--fg); }
  .add-cmt {
    position: absolute;
    right: 3px;
    top: 0;
    opacity: 0;
    border: 1px solid var(--border);
    background: var(--bg-2);
    color: var(--fg);
    border-radius: 4px;
    cursor: pointer;
    line-height: 1.2;
    padding: 0 5px;
  }
  .row:hover .add-cmt { opacity: 1; }

  .finding {
    margin: 7px var(--pad) 9px 62px;
    border: 1px solid var(--border);
    border-left: 3px solid var(--f-acc);
    background: var(--bg-2);
    border-radius: var(--radius-sm);
    padding: var(--pad-xs) var(--pad-sm);
    font-family: var(--ui-font);
  }
  .finding.resolved { opacity: 0.5; }
  .f-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .f-av {
    width: 18px; height: 18px; border-radius: 5px; flex: none;
    background: var(--accent); color: var(--on-accent);
    display: flex; align-items: center; justify-content: center;
    font-size: 10px; font-weight: 700;
  }
  .f-sev {
    font-size: 9px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
    border-radius: 4px; padding: 2px 7px;
  }
  .f-who { font-size: var(--fs-xs); color: var(--text-3); }
  .f-actions { margin-left: auto; display: flex; gap: 4px; }
  .f-actions button,
  .composer-actions button {
    background: var(--bg-3);
    border: 1px solid var(--border);
    color: var(--text-2);
    border-radius: 5px;
    cursor: pointer;
    padding: 3px 9px;
    font: inherit;
    font-size: var(--fs-xs);
    font-weight: 600;
  }
  .f-actions .dismiss { background: transparent; border-color: transparent; color: var(--text-3); }
  .f-actions .dismiss:hover { color: var(--fg); }
  .f-body { color: var(--text-2); }
  .composer { margin: 7px var(--pad) 9px 62px; font-family: var(--ui-font); }
  .composer textarea {
    width: 100%;
    min-height: 3.2em;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--fg);
    font: inherit;
    padding: var(--pad-xs) var(--pad-sm);
    box-sizing: border-box;
  }
  .composer-actions { display: flex; justify-content: flex-end; gap: var(--gap-sm); margin-top: 4px; }
  .composer-actions .primary { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
</style>
