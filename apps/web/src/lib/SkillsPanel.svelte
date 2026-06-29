<script lang="ts">
import type { AgentProvider, ProvidersInfo, Skill } from "@agent-jig/contracts";
import type { JigConnection } from "./connection.svelte.ts";
import Markdown from "./Markdown.svelte";
import { settings } from "./settings.svelte.ts";

interface Props {
  conn: JigConnection;
  providers: ProvidersInfo | null;
}
const { conn, providers }: Props = $props();

type View = { mode: "skill"; skill: Skill } | { mode: "new" } | null;
let view = $state<View>(null);

// Creator state.
let newName = $state("");
let newPrompt = $state("");
let newScope = $state<"repo" | "user">("repo");
let draftBody = $state("");
let genProvider = $state<AgentProvider>(settings.agentSdk);
let genModel = $state(settings.modelFor(settings.agentSdk));
let generating = $state(false);

$effect(() => {
  conn.requestSkills();
});

// Pull a finished draft into the editable body.
$effect(() => {
  const d = conn.skillDraft;
  if (d && generating) {
    generating = false;
    if (d.body) draftBody = d.body;
  }
});

const genModels = $derived(providers?.providers.find((p) => p.id === genProvider)?.models ?? []);

function startNew() {
  view = { mode: "new" };
  newName = "";
  newPrompt = "";
  draftBody = "";
}
function generate() {
  if (!newPrompt.trim()) return;
  generating = true;
  conn.draftSkill(newPrompt.trim(), genProvider, genModel.trim() || null);
}
function save() {
  if (!newName.trim() || !draftBody.trim()) return;
  conn.saveSkill(newScope, newName.trim(), draftBody);
  view = null;
}
</script>

<div class="skills">
  <aside class="sk-list">
    <button class="sk-new" onclick={startNew}>+ New skill</button>
    {#each ["repo", "user"] as const as scope (scope)}
      {@const items = conn.skills.filter((s) => s.scope === scope)}
      {#if items.length > 0}
        <div class="sk-group">{scope === "repo" ? "Project" : "User"}</div>
        {#each items as s (s.path)}
          <button
            class="sk-item"
            class:on={view?.mode === "skill" && view.skill.path === s.path}
            onclick={() => (view = { mode: "skill", skill: s })}
          >
            <span class="sk-name">{s.name}</span>
            {#if s.description}<span class="sk-desc">{s.description}</span>{/if}
          </button>
        {/each}
      {/if}
    {/each}
    {#if conn.skills.length === 0}
      <p class="sk-empty">No skills found in .claude/skills.</p>
    {/if}
  </aside>

  <section class="sk-detail">
    {#if view?.mode === "skill"}
      <div class="sk-head">
        <h3>{view.skill.name}</h3>
        <code class="sk-path">{view.skill.path}</code>
      </div>
      <Markdown text={view.skill.body} />
    {:else if view?.mode === "new"}
      <h3>Create a skill</h3>
      <label for="sk-name">Name</label>
      <input id="sk-name" bind:value={newName} placeholder="my-skill" />

      <label for="sk-prompt">Describe what the skill should do</label>
      <textarea id="sk-prompt" rows="3" bind:value={newPrompt} placeholder="e.g. a skill that writes conventional-commit messages…"></textarea>

      <div class="sk-gen-row">
        <select value={genProvider} onchange={(e) => { genProvider = e.currentTarget.value as AgentProvider; genModel = settings.modelFor(genProvider); }}>
          {#each providers?.providers ?? [{ id: "claude", label: "Claude" }] as p (p.id)}
            <option value={p.id}>{p.label}</option>
          {/each}
        </select>
        <input list="sk-gen-models" bind:value={genModel} placeholder="model" />
        <datalist id="sk-gen-models">{#each genModels as m (m)}<option value={m}></option>{/each}</datalist>
        <button onclick={generate} disabled={generating || !newPrompt.trim()}>
          {generating ? "Generating…" : "Generate"}
        </button>
      </div>

      {#if conn.skillDraft?.error}<p class="sk-err">{conn.skillDraft.error}</p>{/if}

      <label for="sk-body">SKILL.md</label>
      <textarea id="sk-body" class="sk-body" rows="14" bind:value={draftBody} placeholder="Generated SKILL.md appears here — edit before saving."></textarea>

      <div class="sk-save">
        <select bind:value={newScope}>
          <option value="repo">Project (.claude/skills)</option>
          <option value="user">User (~/.claude/skills)</option>
        </select>
        <button class="primary" disabled={!newName.trim() || !draftBody.trim()} onclick={save}>Save skill</button>
      </div>
    {:else}
      <p class="sk-hint">Select a skill to view it, or create a new one.</p>
    {/if}
  </section>
</div>

<style>
  .skills { display: flex; gap: var(--gap); height: 60vh; min-height: 360px; }
  .sk-list {
    width: 220px;
    flex: 0 0 auto;
    overflow-y: auto;
    border-right: 1px solid var(--border);
    padding-right: var(--gap-sm);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .sk-new {
    background: var(--accent);
    color: var(--bg);
    border: 0;
    border-radius: var(--radius-sm);
    padding: var(--pad-xs) var(--pad-sm);
    cursor: pointer;
    font: inherit;
    margin-bottom: var(--gap-sm);
  }
  .sk-group { color: var(--muted); font-size: var(--fs-xs); text-transform: uppercase; margin: var(--gap-sm) 0 2px; }
  .sk-item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    text-align: left;
    background: none;
    border: 0;
    border-radius: var(--radius-sm);
    padding: var(--pad-xs) var(--pad-sm);
    cursor: pointer;
    color: var(--fg);
    font: inherit;
  }
  .sk-item:hover, .sk-item.on { background: var(--bg-2); }
  .sk-name { font-weight: 600; }
  .sk-desc { color: var(--muted); font-size: var(--fs-xs); }
  .sk-empty, .sk-hint { color: var(--muted); padding: var(--gap); }
  .sk-detail { flex: 1; overflow-y: auto; min-width: 0; }
  .sk-head { display: flex; align-items: baseline; gap: var(--gap-sm); margin-bottom: var(--gap-sm); }
  .sk-head h3 { margin: 0; }
  .sk-path { color: var(--muted); font-size: var(--fs-xs); }
  .sk-detail label { display: block; margin: var(--gap-sm) 0 2px; color: var(--muted); font-size: var(--fs-sm); }
  .sk-detail input,
  .sk-detail textarea,
  .sk-detail select {
    width: 100%;
    box-sizing: border-box;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--fg);
    font: inherit;
    padding: var(--pad-xs) var(--pad-sm);
  }
  .sk-body { font-family: var(--code-font); font-size: var(--code-font-size); }
  .sk-gen-row { display: flex; gap: var(--gap-sm); align-items: center; }
  .sk-gen-row select, .sk-gen-row input { width: auto; flex: 1; }
  .sk-gen-row button { flex: 0 0 auto; background: var(--bg-2); border: 1px solid var(--border); color: var(--fg); border-radius: var(--radius-sm); padding: var(--pad-xs) var(--pad-sm); cursor: pointer; font: inherit; }
  .sk-err { color: var(--danger); font-size: var(--fs-sm); }
  .sk-save { display: flex; gap: var(--gap-sm); justify-content: flex-end; align-items: center; margin-top: var(--gap-sm); }
  .sk-save select { width: auto; }
  .sk-save .primary { background: var(--accent); color: var(--bg); border-color: var(--accent); cursor: pointer; }
  .sk-save .primary:disabled { opacity: 0.5; cursor: default; }
</style>
