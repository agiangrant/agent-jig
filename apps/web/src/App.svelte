<script lang="ts">
import type { GovernorEvent, Session } from "@governor/contracts";
import DiffView from "./lib/DiffView.svelte";
import { GovernorConnection } from "./lib/connection.svelte.ts";

const wsBase = import.meta.env.VITE_WS_URL ?? `ws://${location.host}`;
const httpBase = wsBase.replace(/^ws/, "http");

const conn = new GovernorConnection();

let sessions = $state<Session[]>([]);
let activeId = $state<string | null>(null);
let sidebarOpen = $state(true);

// --- Resizable sidebar ---
const MIN_W = 180;
const MAX_W = 520;
let sidebarWidth = $state(240);
let dragging = $state(false);
function startDrag(e: PointerEvent) {
  dragging = true;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function onDrag(e: PointerEvent) {
  if (!dragging) return;
  sidebarWidth = Math.min(MAX_W, Math.max(MIN_W, e.clientX));
}
function endDrag() {
  dragging = false;
}
function onResizeKey(e: KeyboardEvent) {
  if (e.key === "ArrowLeft") sidebarWidth = Math.max(MIN_W, sidebarWidth - 16);
  else if (e.key === "ArrowRight") sidebarWidth = Math.min(MAX_W, sidebarWidth + 16);
}

async function loadSessions() {
  try {
    sessions = (await (await fetch(`${httpBase}/sessions`)).json()) as Session[];
    if (activeId === null && sessions[0]) select(sessions[0].id);
  } catch {
    /* server may be momentarily unavailable */
  }
}
function select(id: string) {
  if (id === activeId) return;
  activeId = id;
  conn.connect(`${wsBase}?session=${id}`);
}
void loadSessions();
setInterval(loadSessions, 3000);

// --- New session modal + directory picker ---
let showNew = $state(false);
let newRepo = $state("");
let newTask = $state("");
let newWorktree = $state(false);
let creating = $state(false);
let createError = $state("");

let browseOpen = $state(false);
let browsePath = $state("");
let browseParent = $state<string | null>(null);
let browseEntries = $state<{ name: string; isRepo: boolean }[]>([]);

function openNew() {
  newRepo = "";
  newTask = "";
  newWorktree = false;
  createError = "";
  browseOpen = false;
  showNew = true;
  void browse(null);
}
async function browse(path: string | null) {
  try {
    const url = path ? `${httpBase}/fs?path=${encodeURIComponent(path)}` : `${httpBase}/fs`;
    const data = (await (await fetch(url)).json()) as {
      path: string;
      parent: string | null;
      entries: { name: string; isRepo: boolean }[];
      error?: string;
    };
    if (data.error) return;
    browsePath = data.path;
    browseParent = data.parent;
    browseEntries = data.entries;
  } catch {
    /* ignore unreadable dir */
  }
}
async function createSession() {
  if (!newRepo.trim() || !newTask.trim()) {
    createError = "Choose a folder and describe the task.";
    return;
  }
  creating = true;
  createError = "";
  try {
    const res = await fetch(`${httpBase}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repoPath: newRepo.trim(),
        prompt: newTask.trim(),
        worktree: newWorktree,
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      createError = body.error ?? "Failed to create session.";
      return;
    }
    const s = (await res.json()) as Session;
    showNew = false;
    await loadSessions();
    select(s.id);
  } finally {
    creating = false;
  }
}
function repoName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

const toggle = () => conn.setDial(conn.mode === "slowed" ? "realtime" : "slowed");

function editEvent(editId: string): GovernorEvent | undefined {
  return conn.events.find((e) => e.editId === editId && e.type === "tool_call");
}
function filePath(payload: unknown): string {
  return ((payload ?? {}) as { file_path?: string }).file_path ?? "";
}
function narrationFor(editId: string): string {
  const e = conn.events.find((x) => x.type === "narration" && x.editId === editId);
  return ((e?.payload ?? {}) as { text?: string }).text ?? "";
}
function riskLabel(r: number): "high" | "med" | "low" {
  if (r >= 0.8) return "high";
  if (r >= 0.4) return "med";
  return "low";
}
function outOfBand(p: unknown): { attributedTo: string; files: { path: string; kind: string }[] } {
  const v = (p ?? {}) as { attributedTo?: string; files?: { path: string; kind: string }[] };
  return { attributedTo: v.attributedTo ?? "external", files: v.files ?? [] };
}
function text(p: unknown): string {
  return ((p ?? {}) as { text?: string }).text ?? "";
}

// --- Conversation: ask the sidecar, or steer the agent ---
let message = $state("");
function ask() {
  const t = message.trim();
  if (!t) return;
  conn.askSidecar(t);
  message = "";
}
function steer() {
  const t = message.trim();
  if (!t) return;
  conn.sendDirective(t);
  message = "";
}
</script>

<div
  class="shell"
  class:dragging
  style="grid-template-columns: {sidebarOpen ? sidebarWidth : 0}px minmax(0, 1fr)"
>
  <nav class="tabs">
    <div class="brand">
      <span>Governor</span>
      <button class="icon" title="Hide sidebar" onclick={() => (sidebarOpen = false)}>‹</button>
    </div>
    <button class="newbtn" onclick={openNew}>+ New session</button>
    {#each sessions as s (s.id)}
      <button class="tab" class:active={s.id === activeId} onclick={() => select(s.id)}>
        <span class="t-repo">{repoName(s.repoPath)}</span>
        <span class="t-task">{s.taskPrompt}</span>
        <span class="t-status {s.status}">{s.status}</span>
      </button>
    {/each}
  </nav>

  {#if sidebarOpen}
    <button
      type="button"
      class="resizer"
      style="left: {sidebarWidth}px"
      aria-label="Resize sidebar"
      onpointerdown={startDrag}
      onpointermove={onDrag}
      onpointerup={endDrag}
      onkeydown={onResizeKey}
    ></button>
  {/if}

  <main>
    {#if !sidebarOpen}
      <button class="reveal" title="Show sidebar" onclick={() => (sidebarOpen = true)}>≡</button>
    {/if}
    {#if activeId === null}
      <p class="empty big">No session selected. Create one to start supervising.</p>
    {:else}
      <header>
        <span class="conn" class:on={conn.connected}>{conn.connected ? "live" : "offline"}</span>
        <button class="dial" class:slowed={conn.mode === "slowed"} onclick={toggle}>
          {conn.mode === "slowed" ? "◐ Slowed" : "● Real-time"}
        </button>
      </header>

      {#if conn.session}
        <p class="task">{conn.session.taskPrompt}</p>
      {/if}

      <div class="cols">
        <section class="left">
          <h2>Queue <span class="count">{conn.queue.length}</span></h2>
          {#if conn.queue.length === 0}
            <p class="empty">Nothing waiting — the agent is working, or idle.</p>
          {:else}
            <ul class="queue">
              {#each conn.queue as edit (edit.editId)}
                <li>
                  <div class="row">
                    <span class="risk {riskLabel(edit.risk)}">{riskLabel(edit.risk)}</span>
                    <code>{edit.path}</code>
                    <span class="tool">{edit.toolName}</span>
                    <button class="reject" onclick={() => conn.rejectEdit(edit.editId)}>Reject</button>
                    <button onclick={() => conn.ack(edit.editId)}>Ack</button>
                  </div>
                  <DiffView toolName={edit.toolName} payload={editEvent(edit.editId)?.payload} />
                </li>
              {/each}
            </ul>
          {/if}

          <h2>Changes by intent</h2>
          {#if conn.changeView.length === 0}
            <p class="empty">No edits yet.</p>
          {:else}
            {#each conn.changeView as g (g.id)}
              <div class="group">
                <p class="label">{g.label}</p>
                {#if g.pattern}
                  {@const rep = editEvent(g.pattern.editIds[0] ?? "")}
                  <div class="edit collapsed">
                    <span class="badge">⊟ {g.pattern.count} structurally identical edits</span>
                    <code>{filePath(rep?.payload)} + {g.pattern.count - 1} more</code>
                    {#if narrationFor(g.pattern.editIds[0] ?? "")}
                      <p class="why-line">💬 {narrationFor(g.pattern.editIds[0] ?? "")}</p>
                    {/if}
                    <DiffView toolName={rep?.toolName ?? ""} payload={rep?.payload} />
                  </div>
                  {#each g.outliers as id (id)}
                    {@const e = editEvent(id)}
                    <div class="edit outlier">
                      <span class="badge warn">⚠ differs from the pattern — worth a look</span>
                      <code>{filePath(e?.payload)}</code>
                      {#if narrationFor(id)}<p class="why-line">💬 {narrationFor(id)}</p>{/if}
                      <DiffView toolName={e?.toolName ?? ""} payload={e?.payload} />
                    </div>
                  {/each}
                {:else}
                  {#each g.editIds as id (id)}
                    {@const e = editEvent(id)}
                    <div class="edit">
                      <code>{filePath(e?.payload)}</code>
                      {#if narrationFor(id)}<p class="why-line">💬 {narrationFor(id)}</p>{/if}
                      <DiffView toolName={e?.toolName ?? ""} payload={e?.payload} />
                    </div>
                  {/each}
                {/if}
              </div>
            {/each}
          {/if}

          <details class="history">
            <summary>History · {conn.events.length} events</summary>
            <ol>
              {#each conn.events as ev (ev.id)}
                {#if ev.type === "out_of_band_change"}
                  <li class="oob">
                    <span class="seq">#{ev.seq}</span>
                    <span class="warn">⚠ changed outside the agent ({outOfBand(ev.payload).attributedTo})</span>
                    <span class="files">{outOfBand(ev.payload).files.map((f) => f.path).join(", ")}</span>
                  </li>
                {:else if ev.type === "reasoning"}
                  <li class="reason"><span class="seq">#{ev.seq}</span><span class="why">{text(ev.payload)}</span></li>
                {:else if ev.type === "directive"}
                  <li class="directive"><span class="seq">#{ev.seq}</span><span class="arrow">→ steer</span><span class="dtext">{text(ev.payload)}</span></li>
                {:else}
                  <li>
                    <span class="seq">#{ev.seq}</span>
                    <span class="etype">{ev.type}</span>
                    {#if ev.toolName}<span class="tool">{ev.toolName}</span>{/if}
                    {#if ev.gateState}<span class="gate {ev.gateState}">{ev.gateState}</span>{/if}
                  </li>
                {/if}
              {/each}
            </ol>
          </details>
        </section>

        <aside class="right">
          <h2>Conversation</h2>
          <div class="chat">
            {#if conn.conversation.length === 0}
              <p class="empty">Ask about provenance, or steer the agent.</p>
            {/if}
            {#each conn.conversation as m, i (i)}
              <div class="msg {m.role}">
                {#if m.role === "sidecar"}<span class="tag">sidecar</span>{/if}
                {#if m.role === "steer"}<span class="tag steer">→ sent to agent</span>{/if}
                {m.text}
              </div>
            {/each}
          </div>
          <form class="compose" onsubmit={(e) => { e.preventDefault(); steer(); }}>
            <input type="text" bind:value={message} placeholder="Ask a question, or steer the agent…" />
            <div class="actions">
              <button type="button" class="ask" onclick={ask}>Ask</button>
              <button type="submit" class="steer">Steer</button>
            </div>
          </form>
        </aside>
      </div>
    {/if}
  </main>
</div>

<svelte:window onkeydown={(e) => { if (showNew && e.key === "Escape") showNew = false; }} />

{#if showNew}
  <div class="overlay">
    <button class="backdrop" aria-label="Close" onclick={() => (showNew = false)}></button>
    <div class="modal" role="dialog" aria-modal="true">
      <h3>New session</h3>

      <label for="repo">Repository</label>
      <div class="repo-field">
        <input id="repo" readonly value={newRepo} placeholder="Choose a folder…" />
        <button type="button" onclick={() => (browseOpen = !browseOpen)}>
          {browseOpen ? "Close" : "Browse…"}
        </button>
      </div>

      {#if browseOpen}
        <div class="browser">
          <div class="browser-path">{browsePath}</div>
          <ul>
            {#if browseParent}
              <li><button type="button" class="dir up" onclick={() => browse(browseParent)}>↑ ..</button></li>
            {/if}
            {#each browseEntries as e (e.name)}
              <li>
                <button type="button" class="dir" onclick={() => browse(`${browsePath}/${e.name}`)}>
                  📁 {e.name}{#if e.isRepo}<span class="repo-badge">git</span>{/if}
                </button>
              </li>
            {/each}
          </ul>
          <button type="button" class="use" onclick={() => { newRepo = browsePath; browseOpen = false; }}>
            Use this folder
          </button>
        </div>
      {/if}

      <label for="task">Task</label>
      <textarea id="task" rows="6" bind:value={newTask} placeholder="Describe the work — multi-line is fine…"></textarea>

      <label class="check">
        <input type="checkbox" bind:checked={newWorktree} />
        Run in an isolated git worktree
      </label>

      {#if createError}<p class="err">{createError}</p>{/if}

      <div class="modal-actions">
        <button type="button" onclick={() => (showNew = false)}>Cancel</button>
        <button type="button" class="primary" disabled={creating} onclick={createSession}>
          {creating ? "Creating…" : "Create"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .shell {
    position: relative;
    display: grid;
    min-height: 100vh;
    transition: grid-template-columns 0.2s ease;
  }
  .shell.dragging {
    transition: none;
    user-select: none;
    cursor: col-resize;
  }
  .resizer {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 9px;
    transform: translateX(-50%);
    cursor: col-resize;
    z-index: 5;
    background: transparent;
    border: 0;
    padding: 0;
  }
  .resizer::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: 1px;
    background: var(--line);
    transform: translateX(-50%);
    transition: background 0.15s, width 0.15s;
  }
  .resizer:hover::after,
  .resizer:focus-visible::after {
    background: var(--accent);
    width: 3px;
  }
  .resizer:focus {
    outline: none;
  }
  .tabs {
    border-right: 1px solid var(--line);
    padding: 16px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    overflow: hidden;
    white-space: nowrap;
  }
  .brand {
    font-weight: 700;
    letter-spacing: 0.5px;
    padding: 4px 8px 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .icon {
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 6px;
    color: var(--muted);
    cursor: pointer;
    font: inherit;
    line-height: 1;
    padding: 2px 8px;
  }
  .icon:hover {
    color: var(--fg);
  }
  .newbtn {
    background: var(--accent);
    color: #0c0d12;
    border: 0;
    border-radius: 6px;
    padding: 8px;
    cursor: pointer;
    font: inherit;
    font-weight: 600;
    margin-bottom: 8px;
  }
  .tab {
    text-align: left;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    padding: 8px 10px;
    cursor: pointer;
    color: var(--fg);
    font: inherit;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .tab:hover {
    background: var(--panel);
  }
  .tab.active {
    background: var(--panel);
    border-color: var(--accent);
  }
  .t-repo {
    font-weight: 600;
    font-size: 13px;
  }
  .t-task {
    color: var(--muted);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .t-status {
    font-size: 10px;
    text-transform: uppercase;
    color: var(--muted);
  }
  .t-status.running {
    color: var(--ok);
  }
  .t-status.error {
    color: var(--danger);
  }

  main {
    position: relative;
    max-width: 1140px;
    width: 100%;
    margin: 0 auto;
    padding: 20px 24px 64px;
  }
  .reveal {
    position: fixed;
    top: 16px;
    left: 12px;
    z-index: 10;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
    color: var(--fg);
    cursor: pointer;
    font: inherit;
    padding: 4px 10px;
  }
  .empty.big {
    margin-top: 80px;
    text-align: center;
    font-size: 14px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 12px;
    border-bottom: 1px solid var(--line);
    padding-bottom: 12px;
  }
  .conn {
    font-size: 11px;
    color: var(--muted);
    text-transform: uppercase;
  }
  .conn.on {
    color: var(--ok);
  }
  .dial {
    background: var(--panel);
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 6px 16px;
    cursor: pointer;
    font: inherit;
  }
  .dial.slowed {
    border-color: var(--warn);
    color: var(--warn);
  }
  .task {
    color: var(--muted);
    border-left: 2px solid var(--line);
    padding-left: 12px;
  }

  .cols {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 360px;
    gap: 28px;
    align-items: start;
  }
  .right {
    position: sticky;
    top: 16px;
  }

  h2 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--muted);
    margin: 24px 0 10px;
  }
  .count {
    color: var(--accent);
  }
  .empty {
    color: var(--muted);
    font-style: italic;
  }
  ul,
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .queue li {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 12px;
    margin-bottom: 6px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .row code {
    flex: 1;
  }
  .row button {
    background: var(--accent);
    color: #0c0d12;
    border: 0;
    border-radius: 6px;
    padding: 4px 14px;
    cursor: pointer;
    font: inherit;
    font-weight: 600;
  }
  .row button.reject {
    background: transparent;
    color: var(--danger);
    border: 1px solid var(--danger);
  }

  .risk {
    font-size: 10px;
    text-transform: uppercase;
    padding: 2px 6px;
    border-radius: 4px;
    border: 1px solid var(--line);
  }
  .risk.high {
    color: var(--danger);
    border-color: var(--danger);
  }
  .risk.med {
    color: var(--warn);
    border-color: var(--warn);
  }
  .risk.low {
    color: var(--muted);
  }
  .tool {
    color: var(--muted);
    font-size: 12px;
  }

  .group {
    border-left: 2px solid var(--accent);
    padding-left: 12px;
    margin-bottom: 18px;
  }
  .group .label {
    color: var(--fg);
    font-weight: 600;
    margin: 0 0 8px;
  }
  .group .edit {
    margin-bottom: 8px;
  }
  .group .edit code {
    color: var(--muted);
    font-size: 12px;
  }
  .badge {
    display: inline-block;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 4px;
    border: 1px solid var(--line);
    color: var(--muted);
    margin-right: 8px;
  }
  .badge.warn {
    color: var(--warn);
    border-color: var(--warn);
  }
  .edit.outlier {
    border-left: 2px solid var(--warn);
    padding-left: 10px;
  }
  .why-line {
    color: var(--accent);
    font-style: italic;
    margin: 6px 0;
    opacity: 0.9;
  }

  .history {
    margin-top: 28px;
    border-top: 1px solid var(--line);
    padding-top: 8px;
  }
  .history summary {
    cursor: pointer;
    color: var(--muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
  }
  .history li {
    display: flex;
    gap: 10px;
    align-items: baseline;
    padding: 3px 0;
    color: var(--muted);
  }
  .history .seq {
    color: var(--line);
    min-width: 42px;
  }
  .history .etype {
    color: var(--fg);
  }
  .gate {
    font-size: 10px;
    text-transform: uppercase;
  }
  .gate.pending {
    color: var(--warn);
  }
  .gate.released {
    color: var(--ok);
  }
  .gate.bypassed {
    color: var(--muted);
  }
  .gate.rejected {
    color: var(--danger);
  }
  .oob .warn {
    color: var(--warn);
  }
  .reason .why {
    color: var(--accent);
    font-style: italic;
    opacity: 0.85;
  }
  .directive .arrow {
    color: var(--accent);
    font-weight: 600;
  }

  .chat {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 10px;
    max-height: 60vh;
    overflow-y: auto;
  }
  .msg {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 12px;
    max-width: 90%;
    white-space: pre-wrap;
    font-size: 13px;
  }
  .msg.you {
    align-self: flex-end;
    background: var(--panel);
  }
  .msg.sidecar {
    align-self: flex-start;
    background: #0f1015;
  }
  .msg.steer {
    align-self: flex-end;
    border-color: var(--accent);
  }
  .tag {
    display: block;
    font-size: 10px;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 2px;
  }
  .tag.steer {
    color: var(--accent);
  }

  .compose {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .compose input {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 12px;
    color: var(--fg);
    font: inherit;
  }
  .actions {
    display: flex;
    gap: 8px;
  }
  .actions button {
    flex: 1;
    border-radius: 8px;
    padding: 8px 14px;
    cursor: pointer;
    font: inherit;
  }
  .actions .ask {
    background: var(--panel);
    color: var(--fg);
    border: 1px solid var(--line);
  }
  .actions .steer {
    background: var(--accent);
    color: #0c0d12;
    border: 0;
    font-weight: 600;
  }

  /* --- New session modal --- */
  .overlay {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    z-index: 50;
  }
  .backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    border: 0;
    padding: 0;
    cursor: default;
  }
  .modal {
    position: relative;
    z-index: 1;
    background: var(--bg, #0c0d12);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 22px 24px;
    width: 100%;
    max-width: 560px;
    max-height: 86vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .modal h3 {
    margin: 0 0 8px;
  }
  .modal label {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--muted);
    margin-top: 8px;
  }
  .modal label.check {
    display: flex;
    align-items: center;
    gap: 8px;
    text-transform: none;
    letter-spacing: 0;
    font-size: 13px;
    color: var(--fg);
    cursor: pointer;
  }
  .repo-field {
    display: flex;
    gap: 8px;
  }
  .repo-field input {
    flex: 1;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 12px;
    color: var(--fg);
    font: inherit;
    min-width: 0;
  }
  .repo-field button,
  .browser .use {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 14px;
    color: var(--fg);
    cursor: pointer;
    font: inherit;
  }
  .browser {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .browser-path {
    font-size: 11px;
    color: var(--muted);
    font-family: ui-monospace, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .browser ul {
    max-height: 220px;
    overflow-y: auto;
  }
  .browser .dir {
    width: 100%;
    text-align: left;
    background: transparent;
    border: 0;
    border-radius: 6px;
    padding: 5px 8px;
    color: var(--fg);
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .browser .dir:hover {
    background: var(--panel);
  }
  .browser .dir.up {
    color: var(--muted);
  }
  .repo-badge {
    font-size: 10px;
    text-transform: uppercase;
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 4px;
    padding: 0 5px;
  }
  .browser .use {
    align-self: flex-start;
    font-weight: 600;
  }
  .modal textarea {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 10px 12px;
    color: var(--fg);
    font: inherit;
    resize: vertical;
  }
  .err {
    color: var(--danger);
    font-size: 13px;
    margin: 4px 0 0;
  }
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
  }
  .modal-actions button {
    border-radius: 8px;
    padding: 8px 18px;
    cursor: pointer;
    font: inherit;
    background: var(--panel);
    border: 1px solid var(--line);
    color: var(--fg);
  }
  .modal-actions .primary {
    background: var(--accent);
    color: #0c0d12;
    border: 0;
    font-weight: 600;
  }
  .modal-actions .primary:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
