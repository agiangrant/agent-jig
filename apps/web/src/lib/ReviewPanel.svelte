<script lang="ts">
import type { AgentProvider, ProvidersInfo, ReviewComment } from "@agent-jig/contracts";
import AgentPicker from "./AgentPicker.svelte";
import type { JigConnection } from "./connection.svelte.ts";
import ReviewDiff from "./ReviewDiff.svelte";
import { settings } from "./settings.svelte.ts";

interface Props {
  conn: JigConnection;
  providers: ProvidersInfo | null;
}
const { conn, providers }: Props = $props();

let summary = $state("");
let reviewer = $state<AgentProvider>(settings.reviewerSdk);
let reviewerModel = $state(settings.reviewerModelFor(settings.reviewerSdk));

function pickReviewer(p: AgentProvider, model: string) {
  reviewer = p;
  reviewerModel = model;
  settings.setReviewerSdk(p);
  settings.setReviewerModelFor(p, model);
}
function runReview() {
  conn.requestReview(reviewer, reviewerModel.trim() || null, settings.reviewPrompt.trim() || null);
}

// (Re)compute the PR diff whenever the Changes view mounts.
$effect(() => {
  conn.requestReviewDiff();
});

function commentsFor(path: string): ReviewComment[] {
  return conn.reviewComments.filter((c) => c.path === path);
}

// Master-detail: a file rail navigates; one file's diff renders at a time (so a
// long session never mounts every diff at once).
let selected = $state<string | null>(null);
const selectedFile = $derived(conn.reviewDiff.find((f) => f.path === selected) ?? conn.reviewDiff[0]);
$effect(() => {
  // Keep selection valid as the diff list changes; default to the first file.
  if (conn.reviewDiff.length > 0 && !conn.reviewDiff.some((f) => f.path === selected)) {
    selected = conn.reviewDiff[0].path;
  }
});

const TAG: Record<string, { letter: string; color: string }> = {
  added: { letter: "A", color: "var(--go)" },
  modified: { letter: "M", color: "var(--warm)" },
  deleted: { letter: "D", color: "var(--danger)" },
  renamed: { letter: "R", color: "var(--accent)" },
};
function fileMeta(path: string, status: string) {
  const cs = conn.reviewComments.filter((c) => c.path === path && !c.resolved);
  const dot = cs.some((c) => c.severity === "issue")
    ? "var(--danger)"
    : cs.some((c) => c.severity === "warning")
      ? "var(--warm)"
      : cs.length > 0
        ? "var(--accent)"
        : "var(--text-3)";
  return { count: cs.length, dot, tag: TAG[status] ?? TAG.modified };
}

const open = $derived(conn.reviewComments.filter((c) => !c.resolved));
const ai = $derived(open.filter((c) => c.author !== "human"));
const mustFix = $derived(ai.filter((c) => c.severity === "issue").length);
const suggestions = $derived(ai.filter((c) => c.severity !== "issue").length);
const status = $derived(conn.reviewStatus);
const label = $derived(providers?.providers.find((p) => p.id === reviewer)?.label ?? reviewer);
const reviewerName = $derived(label.split(" ")[0]);
const summaryTitle = $derived(
  ai.length > 0
    ? `${reviewerName} reviewed ${conn.reviewDiff.length} file${conn.reviewDiff.length === 1 ? "" : "s"}`
    : `${conn.reviewDiff.length} changed file${conn.reviewDiff.length === 1 ? "" : "s"}`,
);
</script>

<div class="review">
  <div class="reviewer-bar">
    <div class="rb-left">
      <span class="rb-av">{reviewerName.slice(0, 1).toUpperCase()}</span>
      <div class="rb-meta">
        <div class="rb-title">{summaryTitle}</div>
        <div class="rb-sub">
          {#if ai.length > 0}
            <span class="dotnum danger"><span class="d"></span>{mustFix} must-fix</span>
            <span class="dotnum warm"><span class="d"></span>{suggestions} suggestion{suggestions === 1 ? "" : "s"}</span>
          {:else}
            <span class="muted">No AI review yet</span>
          {/if}
          {#if status.status === "error" && status.error}<span class="rb-err">· {status.error}</span>{/if}
        </div>
      </div>
    </div>

    <div class="rb-right">
      <button
        class="auto"
        class:on={conn.session?.autoReview ?? false}
        title="Review automatically whenever the agent finishes"
        onclick={() => conn.setAutoReview(!(conn.session?.autoReview ?? false))}
      >
        <span class="switch"><span class="knob"></span></span>
        Auto
      </button>

      <AgentPicker
        {providers}
        provider={reviewer}
        model={reviewerModel}
        label="Reviewer"
        align="right"
        onpick={pickReviewer}
      />

      <button class="request" disabled={status.status === "running"} onclick={runReview}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4z" /></svg>
        {status.status === "running" ? "Reviewing…" : "Request review"}
      </button>
    </div>
  </div>

  {#if conn.reviewDiff.length === 0}
    <div class="empty">No changes against the base commit yet.</div>
  {:else}
    <div class="review-body">
      <aside class="file-rail">
        <div class="rail-head">
          <span>Files</span>
          <span class="rail-count">{conn.reviewDiff.length} files</span>
        </div>
        <div class="rail-list gv-scroll">
          {#each conn.reviewDiff as f (f.path)}
            {@const m = fileMeta(f.path, f.status)}
            <button class="rail-item" class:on={selected === f.path} title={f.path} onclick={() => (selected = f.path)}>
              <span class="dot" style="background:{m.dot}"></span>
              <span class="rail-name">{f.path}</span>
              {#if m.count > 0}<span class="rail-cnt">{m.count}</span>{/if}
              <span class="rail-tag" style="color:{m.tag.color}">{m.tag.letter}</span>
            </button>
          {/each}
        </div>
      </aside>

      <div class="file-view">
        {#if selectedFile}
          {#key selectedFile.path}
            <ReviewDiff
              file={selectedFile}
              comments={commentsFor(selectedFile.path)}
              onAdd={(c) => conn.addReviewComment(c)}
              onResolve={(id, resolved) => conn.resolveReviewComment(id, resolved)}
              onDismiss={(id) => conn.deleteReviewComment(id)}
            />
          {/key}
        {/if}
      </div>
    </div>

    <div class="submit">
      <input bind:value={summary} placeholder="Overall note for the coder (optional)…" />
      <button
        class="primary"
        disabled={open.length === 0 && !summary.trim()}
        onclick={() => {
          conn.submitReview(summary.trim());
          summary = "";
        }}
      >
        Send fixes to coder ({open.length})
      </button>
    </div>
  {/if}
</div>

<style>
  .review { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .reviewer-bar {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--gap);
    padding: var(--pad-sm) var(--pad);
    border-bottom: 1px solid var(--border-soft);
    background: var(--bg-1);
    position: relative;
  }
  .rb-left { display: flex; align-items: center; gap: 11px; min-width: 0; flex: 1; }
  .rb-av {
    width: 32px; height: 32px; border-radius: 9px; flex: none;
    background: var(--accent); color: var(--on-accent);
    display: flex; align-items: center; justify-content: center;
    font-size: 13px; font-weight: 700;
  }
  .rb-title { font-size: var(--fs-sm); color: var(--fg); font-weight: 600; }
  .rb-sub { display: flex; align-items: center; gap: 11px; margin-top: 2px; font-size: var(--fs-xs); }
  .dotnum { display: flex; align-items: center; gap: 5px; font-weight: 600; }
  .dotnum .d { width: 7px; height: 7px; border-radius: 50%; }
  .dotnum.danger { color: var(--danger); } .dotnum.danger .d { background: var(--danger); }
  .dotnum.warm { color: var(--warm); } .dotnum.warm .d { background: var(--warm); }
  .rb-sub .muted { color: var(--text-3); }
  .rb-err { color: var(--danger); }

  .rb-right { flex: none; display: flex; align-items: center; gap: 10px; }
  .auto {
    display: flex; align-items: center; gap: 8px;
    border: 1px solid var(--border); background: var(--bg-2);
    border-radius: 8px; cursor: pointer; font: inherit; padding: 6px 11px;
    color: var(--text-2); font-size: var(--fs-sm); font-weight: 600;
  }
  .auto:hover { background: var(--bg-3); }
  .auto .switch {
    width: 30px; height: 17px; border-radius: 999px; background: var(--bg-3);
    position: relative; flex: none; transition: background 0.18s;
  }
  .auto .knob {
    position: absolute; top: 2px; left: 2px; width: 13px; height: 13px;
    border-radius: 50%; background: var(--text-3); transition: left 0.18s, background 0.18s;
  }
  .auto.on { color: var(--fg); }
  .auto.on .switch { background: var(--accent); }
  .auto.on .knob { left: 15px; background: var(--on-accent); }

  .request {
    border: 0; background: var(--accent); color: var(--on-accent);
    cursor: pointer; font: inherit; font-weight: 700; font-size: var(--fs-sm);
    border-radius: 8px; padding: 9px 15px; display: flex; align-items: center; gap: 7px;
  }
  .request:hover { filter: brightness(1.08); }
  .request:disabled { opacity: 0.6; cursor: default; filter: none; }

  .empty { color: var(--text-3); padding: var(--pad); text-align: center; }

  .review-body { flex: 1; display: flex; min-height: 0; }
  .file-rail {
    width: 272px; flex: none; min-height: 0;
    display: flex; flex-direction: column;
    border-right: 1px solid var(--border-soft); background: var(--bg);
  }
  .rail-head {
    flex: none; display: flex; align-items: center; gap: 8px;
    padding: var(--pad-sm) var(--pad); border-bottom: 1px solid var(--border-soft);
    font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: 0.07em;
    color: var(--text-3); font-weight: 700;
  }
  .rail-count { margin-left: auto; text-transform: none; letter-spacing: 0; font-weight: 400; }
  .rail-list { flex: 1; overflow-y: auto; min-height: 0; padding: var(--pad-xs); }
  .rail-item {
    width: 100%; text-align: left; display: flex; align-items: center; gap: 8px;
    border: 1px solid transparent; background: none; border-radius: var(--radius-sm);
    padding: 7px var(--pad-sm); margin-bottom: 2px; cursor: pointer; font: inherit; color: var(--fg);
  }
  .rail-item:hover { background: var(--bg-2); }
  .rail-item.on { background: var(--bg-3); border-color: var(--border); }
  .rail-item .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
  .rail-name {
    font-family: var(--code-font); font-size: var(--fs-sm); flex: 1; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left;
  }
  .rail-cnt {
    font-size: 9px; font-weight: 700; color: #fff; background: var(--danger);
    border-radius: 999px; padding: 1px 6px; flex: none;
  }
  .rail-tag { width: 14px; text-align: center; font-size: 10px; font-weight: 700; flex: none; }
  .file-view { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .submit {
    flex: none; display: flex; gap: var(--gap-sm); align-items: center;
    padding: var(--pad-sm) var(--pad); border-top: 1px solid var(--border-soft); background: var(--bg-1);
  }
  .submit input {
    flex: 1; min-width: 0; background: var(--bg-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); color: var(--fg); font: inherit; padding: var(--pad-xs) var(--pad-sm);
  }
  .submit .primary {
    flex: none; background: var(--accent); color: var(--on-accent);
    border: 1px solid var(--accent); border-radius: var(--radius-sm);
    padding: var(--pad-xs) var(--pad); cursor: pointer; font: inherit; font-weight: 700;
  }
  .submit .primary:disabled { opacity: 0.5; cursor: default; }
</style>
