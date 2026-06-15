<script lang="ts">
import type { GovernorEvent, Session, SessionSummary } from "@governor/contracts";
import DiffView from "./lib/DiffView.svelte";
import { GovernorConnection } from "./lib/connection.svelte.ts";
import { diffMode } from "./lib/diffMode.svelte.ts";
import { settings } from "./lib/settings.svelte.ts";
import { theme } from "./lib/theme.svelte.ts";

void theme.init(); // load custom themes + apply the saved selection's chrome
settings.apply(); // apply persisted fonts + tab size

let showSettings = $state(false);
let showTheme = $state(false);

// Font suggestions: the machine's actual installed families when the Local Font
// Access API is available (Chromium, on a user gesture); otherwise curated lists.
let installedFonts = $state<string[]>([]);
const fontApiAvailable = typeof window !== "undefined" && "queryLocalFonts" in window;
async function detectFonts() {
  const q = (window as unknown as { queryLocalFonts?: () => Promise<Array<{ family: string }>> })
    .queryLocalFonts;
  if (!q) return;
  try {
    const data = await q.call(window);
    installedFonts = [...new Set(data.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
  } catch {
    /* permission denied / unavailable — keep the curated suggestions */
  }
}
let themeJson = $state("");
let themeError = $state("");
async function importTheme() {
  try {
    await theme.importTheme(themeJson);
    showTheme = false;
    themeJson = "";
    themeError = "";
  } catch (e) {
    themeError = (e as Error).message ?? "invalid theme JSON";
  }
}

const wsBase = import.meta.env.VITE_WS_URL ?? `ws://${location.host}`;
const httpBase = wsBase.replace(/^ws/, "http");

const conn = new GovernorConnection();

let sessions = $state<SessionSummary[]>([]);
let activeId = $state<string | null>(null);
let sidebarOpen = $state(true);
// Measured header height so the sticky conversation column tucks right below it
// (the header grows when the prompt accordion is expanded).
let headerH = $state(0);

// --- Resizable / collapsible conversation column ---
const CHAT_W_KEY = "governor:chatWidth";
const CHAT_OPEN_KEY = "governor:chatOpen";
const CHAT_MIN = 260;
const CHAT_MAX = 680;
function loadChatWidth(): number {
  try {
    const n = Number(localStorage.getItem(CHAT_W_KEY));
    return Number.isFinite(n) && n > 0 ? Math.min(CHAT_MAX, Math.max(CHAT_MIN, n)) : 360;
  } catch {
    return 360;
  }
}
function loadChatOpen(): boolean {
  try {
    return localStorage.getItem(CHAT_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}
let chatWidth = $state(loadChatWidth());
let chatOpen = $state(loadChatOpen());
let chatDragging = $state(false);
let chatDragX = 0;
let chatDragW = 0;
function setChatOpen(v: boolean) {
  chatOpen = v;
  try {
    localStorage.setItem(CHAT_OPEN_KEY, v ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
}
function chatDragStart(e: PointerEvent) {
  chatDragging = true;
  chatDragX = e.clientX;
  chatDragW = chatWidth;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function chatDragMove(e: PointerEvent) {
  if (!chatDragging) return;
  // Dragging left widens the chat (it's on the right).
  chatWidth = Math.min(CHAT_MAX, Math.max(CHAT_MIN, chatDragW - (e.clientX - chatDragX)));
}
function chatDragEnd() {
  if (!chatDragging) return;
  chatDragging = false;
  try {
    localStorage.setItem(CHAT_W_KEY, String(chatWidth));
  } catch {
    /* storage unavailable */
  }
}
function chatDragKey(e: KeyboardEvent) {
  if (e.key === "ArrowLeft") chatWidth = Math.min(CHAT_MAX, chatWidth + 16);
  else if (e.key === "ArrowRight") chatWidth = Math.max(CHAT_MIN, chatWidth - 16);
}

// Remember the active session across refreshes/restarts (URL hash wins, then storage).
const ACTIVE_KEY = "governor:activeSession";
function savedActiveId(): string | null {
  const fromHash = location.hash.slice(1);
  if (fromHash) return fromHash;
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

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
    sessions = (await (await fetch(`${httpBase}/sessions`)).json()) as SessionSummary[];
    if (activeId === null && sessions.length > 0) {
      const preferred = savedActiveId();
      const pick = preferred && sessions.some((s) => s.id === preferred) ? preferred : sessions[0]?.id;
      if (pick) select(pick);
    }
  } catch {
    /* server may be momentarily unavailable */
  }
}
function select(id: string) {
  if (id === activeId) return;
  activeId = id;
  try {
    localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    /* storage may be unavailable */
  }
  location.hash = id;
  conn.connect(`${wsBase}?session=${id}`);
}
void loadSessions();
setInterval(loadSessions, 3000);

// Live tab updates: the server pushes the summary on any attention change, so
// badges refresh instantly; the poll above stays as a backstop.
$effect(() => {
  if (conn.summary) sessions = conn.summary;
});

// --- Rename / close tabs ---
let editing = $state<string | null>(null);
let renameText = $state("");
function focusOnMount(node: HTMLInputElement) {
  node.focus();
  node.select();
}
function startRename(s: Session) {
  editing = s.id;
  renameText = s.title ?? s.taskPrompt;
}
async function commitRename() {
  const id = editing;
  const title = renameText.trim();
  editing = null;
  if (!id || !title) return;
  await fetch(`${httpBase}/sessions/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  await loadSessions();
}
function renameKey(e: KeyboardEvent) {
  if (e.key === "Enter") commitRename();
  else if (e.key === "Escape") editing = null;
}
async function closeTab(s: Session) {
  const label = s.title ?? s.taskPrompt;
  if (!window.confirm(`Close "${label}"?\nThis removes the session and its history.`)) return;
  await fetch(`${httpBase}/sessions/${s.id}`, { method: "DELETE" });
  if (s.id === activeId) activeId = null;
  await loadSessions();
}

// --- Drag to reorder tabs (persisted locally) ---
const ORDER_KEY = "governor:tabOrder";
function loadOrder(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]");
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}
let tabOrder = $state<string[]>(loadOrder());
function saveOrder(ids: string[]) {
  tabOrder = ids;
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(ids));
  } catch {
    /* storage unavailable */
  }
}
// Tabs sorted by the saved order; unseen (new) sessions keep their natural order at the end.
const orderedSessions = $derived.by(() => {
  const pos = new Map(tabOrder.map((id, i) => [id, i]));
  return [...sessions].sort((a, b) => (pos.get(a.id) ?? Infinity) - (pos.get(b.id) ?? Infinity));
});

let dragId = $state<string | null>(null);
let overId = $state<string | null>(null);
function onDragStart(e: DragEvent, id: string) {
  dragId = id;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  }
}
function onDragOver(e: DragEvent, id: string) {
  if (dragId === null) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  overId = id;
}
function onDrop(e: DragEvent, targetId: string) {
  e.preventDefault();
  const from = dragId;
  dragId = null;
  overId = null;
  if (!from || from === targetId) return;
  const ids = orderedSessions.map((s) => s.id);
  const [moved] = ids.splice(ids.indexOf(from), 1);
  if (moved === undefined) return;
  ids.splice(ids.indexOf(targetId), 0, moved); // place before the drop target
  saveOrder(ids);
}
function onDragEnd() {
  dragId = null;
  overId = null;
}

// --- New session modal ---
let showNew = $state(false);
let newRepo = $state("");
let newTask = $state("");
let newWorktree = $state(false);
let newPlan = $state(false);
let creating = $state(false);
let createError = $state("");

// Recently-chosen repo folders, for quick re-selection (persisted locally).
const RECENT_KEY = "governor:recentFolders";
function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}
let recentFolders = $state<string[]>(loadRecent());
function rememberFolder(path: string) {
  recentFolders = [path, ...recentFolders.filter((p) => p !== path)].slice(0, 8);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentFolders));
  } catch {
    /* storage may be unavailable */
  }
}

function openNew() {
  newRepo = "";
  newTask = "";
  newWorktree = false;
  newPlan = false;
  createError = "";
  showNew = true;
}
async function pickFolder() {
  try {
    const res = await fetch(`${httpBase}/pick-folder`);
    if (!res.ok) return;
    const data = (await res.json()) as { path?: string };
    if (data.path) newRepo = data.path;
  } catch {
    /* picker unavailable — fall back to typing a path */
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
        planMode: newPlan,
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      createError = body.error ?? "Failed to create session.";
      return;
    }
    const s = (await res.json()) as Session;
    rememberFolder(newRepo.trim());
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

// Per-diff collapse in "Changes by intent". Default: expanded while you review,
// auto-collapsed once the edit is acted on (acked/rejected). A manual toggle
// records an override that wins from then on, so acting on *other* edits never
// disturbs a diff you've deliberately opened or closed.
let collapseOverride = $state<Record<string, boolean>>({});
function isActedOn(editId: string): boolean {
  return conn.events.some((e) => e.type === "ack" && e.editId === editId);
}
function isCollapsed(editId: string): boolean {
  const override = collapseOverride[editId];
  return override !== undefined ? override : isActedOn(editId);
}
function toggleCollapse(editId: string) {
  collapseOverride[editId] = !isCollapsed(editId);
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

// --- Answering the agent's AskUserQuestion ---
let picks = $state<Record<string, string[]>>({});
let other = $state<Record<string, string>>({});
let lastQuestionId = "";
$effect(() => {
  const id = conn.question?.id ?? "";
  if (id !== lastQuestionId) {
    lastQuestionId = id;
    picks = {};
    other = {};
  }
});
function isPicked(q: string, label: string): boolean {
  return (picks[q] ?? []).includes(label);
}
function togglePick(q: string, label: string, multi: boolean) {
  const cur = picks[q] ?? [];
  const next = multi
    ? cur.includes(label)
      ? cur.filter((l) => l !== label)
      : [...cur, label]
    : [label];
  picks = { ...picks, [q]: next };
}
function answerFor(q: string): string {
  const o = (other[q] ?? "").trim();
  return o.length > 0 ? o : (picks[q] ?? []).join(", ");
}
function setOther(q: string, value: string) {
  other = { ...other, [q]: value };
}
function canSubmit(question: { questions: { question: string }[] }): boolean {
  return question.questions.every((qq) => answerFor(qq.question).length > 0);
}
function submitAnswers(question: { id: string; questions: { question: string }[] }) {
  const answers: Record<string, string> = {};
  for (const qq of question.questions) answers[qq.question] = answerFor(qq.question);
  conn.answerQuestion(question.id, answers);
}

// --- Plan approval (ExitPlanMode) ---
let planReason = $state("");
function approvePlan(id: string) {
  conn.decidePlan(id, true);
  planReason = "";
}
function requestPlanChanges(id: string) {
  const r = planReason.trim();
  if (!r) return;
  conn.decidePlan(id, false, r);
  planReason = "";
}

// --- Command palette (⌘K / ⌘P) ---
interface Command {
  id: string;
  label: string;
  hint?: string;
  /** Extra text to match against (e.g. a session's repo). */
  search?: string;
  /** A theme to live-preview while highlighted (theme sub-view). */
  themeName?: string;
  /** Keep the palette open after running (e.g. opening a sub-view). */
  keepOpen?: boolean;
  run: () => void;
}
let paletteOpen = $state(false);
let paletteQuery = $state("");
let paletteIndex = $state(0);
let paletteView = $state<"root" | "theme">("root");
let themeReturn: string | null = null; // theme to revert to if a preview is cancelled

// Top level: actions + tabs. Themes live behind a single "Theme…" sub-view to
// avoid flooding the list.
const rootCommands = $derived<Command[]>([
  { id: "theme", label: "Theme…", hint: theme.current, keepOpen: true, run: enterThemeView },
  { id: "diff:split", label: "Diff layout: Side-by-side", run: () => diffMode.set("split") },
  { id: "diff:unified", label: "Diff layout: Unified", run: () => diffMode.set("unified") },
  { id: "diff:ba", label: "Diff layout: Before/After", run: () => diffMode.set("ba") },
  {
    id: "lines",
    label: diffMode.lineNumbers ? "Line numbers: hide" : "Line numbers: show",
    run: () => diffMode.toggleLineNumbers(),
  },
  ...(activeId
    ? [
        {
          id: "dial",
          label: conn.mode === "slowed" ? "Dial: switch to Real-time" : "Dial: switch to Slowed",
          run: toggle,
        },
      ]
    : []),
  { id: "settings", label: "Settings…", run: () => (showSettings = true) },
  { id: "new", label: "New session…", run: openNew },
  { id: "import-theme", label: "Import VSCode theme…", run: () => (showTheme = true) },
  // Tabs: searchable by title and repo.
  ...orderedSessions.map((s) => ({
    id: `go:${s.id}`,
    label: `Go to: ${s.title ?? s.taskPrompt}`,
    hint: s.id === activeId ? "current" : repoName(s.repoPath),
    search: `${s.taskPrompt} ${s.repoPath}`,
    run: () => select(s.id),
  })),
]);
const themeCommands = $derived<Command[]>(
  theme.available.map((t) => ({
    id: `theme:${t}`,
    label: t,
    themeName: t,
    run: () => {
      theme.select(t);
      themeReturn = null; // committed — don't revert on close
    },
  })),
);
const commandList = $derived(paletteView === "theme" ? themeCommands : rootCommands);
const filtered = $derived(
  paletteQuery.trim() === ""
    ? commandList
    : commandList.filter((c) =>
        `${c.label} ${c.search ?? ""}`.toLowerCase().includes(paletteQuery.toLowerCase()),
      ),
);

// Live-preview the highlighted theme while in the theme sub-view.
$effect(() => {
  if (!paletteOpen || paletteView !== "theme") return;
  const c = filtered[Math.min(paletteIndex, filtered.length - 1)];
  if (c?.themeName) theme.preview(c.themeName);
});

function openPalette() {
  paletteOpen = true;
  paletteView = "root";
  paletteQuery = "";
  paletteIndex = 0;
}
function closePalette() {
  if (paletteView === "theme" && themeReturn !== null) theme.preview(themeReturn); // revert uncommitted
  paletteOpen = false;
  paletteView = "root";
  themeReturn = null;
}
function enterThemeView() {
  themeReturn = theme.current;
  paletteView = "theme";
  paletteQuery = "";
  paletteIndex = Math.max(0, theme.available.indexOf(theme.current)); // highlight current first
}
function exitThemeView() {
  if (themeReturn !== null) theme.preview(themeReturn); // revert preview
  themeReturn = null;
  paletteView = "root";
  paletteQuery = "";
  paletteIndex = 0;
}
function runCommand(c: Command) {
  c.run();
  if (!c.keepOpen) closePalette();
}
function paletteKey(e: KeyboardEvent) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    paletteIndex = Math.min(paletteIndex + 1, filtered.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    paletteIndex = Math.max(paletteIndex - 1, 0);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const c = filtered[paletteIndex];
    if (c) runCommand(c);
  }
}
function onGlobalKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && (e.key === "p" || e.key === "k")) {
    e.preventDefault();
    openPalette();
    return;
  }
  if (e.key === "Escape") {
    if (paletteOpen) {
      if (paletteView === "theme") exitThemeView();
      else closePalette();
      return;
    }
    showNew = false;
    showTheme = false;
    showSettings = false;
  }
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
    <div class="tab-list">
      {#each orderedSessions as s (s.id)}
      <!-- svelte-ignore a11y_no_static_element_interactions -- drag is a pointer-only
           enhancement; the inner buttons handle keyboard select/close -->
      <div
        class="tab"
        class:active={s.id === activeId}
        class:dragging={dragId === s.id}
        class:over={overId === s.id && dragId !== null && dragId !== s.id}
        draggable={editing !== s.id}
        ondragstart={(e) => onDragStart(e, s.id)}
        ondragover={(e) => onDragOver(e, s.id)}
        ondrop={(e) => onDrop(e, s.id)}
        ondragend={onDragEnd}
      >
        {#if editing === s.id}
          <input
            class="tab-rename"
            bind:value={renameText}
            onkeydown={renameKey}
            onblur={commitRename}
            use:focusOnMount
          />
        {:else}
          <button
            class="tab-main"
            onclick={() => select(s.id)}
            ondblclick={() => startRename(s)}
            title="Double-click to rename"
          >
            <span class="t-repo">{repoName(s.repoPath)}</span>
            <span class="t-task">{s.title ?? s.taskPrompt}</span>
            <span class="t-status {s.status}">{s.status}</span>
          </button>
          {#if s.awaitingPlan}
            <span class="t-badge plan" title="Plan awaiting approval">plan</span>
          {:else if s.awaitingQuestion}
            <span class="t-badge ask" title="Waiting for your answer">?</span>
          {:else if s.pendingEdits > 0}
            <span class="t-badge" title="{s.pendingEdits} edit{s.pendingEdits > 1 ? 's' : ''} awaiting review">
              {s.pendingEdits}
            </span>
          {/if}
          <button class="tab-close" title="Close session" onclick={() => closeTab(s)}>×</button>
        {/if}
      </div>
      {/each}
    </div>

    <div class="nav-footer">
      <button class="settings-btn" onclick={() => (showSettings = true)}>⚙ Settings</button>
    </div>
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
      <header class:shifted={!sidebarOpen} bind:clientHeight={headerH}>
        <div class="head-top">
          <h1 class="title">{conn.session?.title ?? conn.session?.taskPrompt ?? "Session"}</h1>
          <div class="head-controls">
            <span class="conn" class:on={conn.connected}>{conn.connected ? "live" : "offline"}</span>
            <button class="dial" class:slowed={conn.mode === "slowed"} onclick={toggle}>
              {conn.mode === "slowed" ? "◐ Slowed" : "● Real-time"}
            </button>
          </div>
        </div>
        {#if conn.session?.taskPrompt}
          <details class="prompt-acc">
            <summary>Prompt</summary>
            <p>{conn.session.taskPrompt}</p>
          </details>
        {/if}
      </header>

      <div class="cols" class:dragging={chatDragging}>
        <section class="left">
          {#if conn.plan}
            {@const pl = conn.plan}
            <section class="plan">
              <h2 class="plan-title">The agent has a plan — approve to start editing</h2>
              <pre class="plan-body">{pl.plan}</pre>
              <textarea
                class="plan-reason"
                rows="2"
                bind:value={planReason}
                placeholder="Request changes (feedback for the agent)…"
              ></textarea>
              <div class="plan-actions">
                <button class="plan-changes" disabled={!planReason.trim()} onclick={() => requestPlanChanges(pl.id)}>
                  Request changes
                </button>
                <button class="plan-approve" onclick={() => approvePlan(pl.id)}>Approve &amp; execute</button>
              </div>
            </section>
          {/if}

          {#if conn.question}
            {@const aq = conn.question}
            <section class="question">
              <h2 class="q-title">The agent is asking you</h2>
              {#each aq.questions as q (q.question)}
                <div class="q">
                  <div class="q-head">
                    <span class="q-chip">{q.header}</span>
                    {#if q.multiSelect}<span class="q-multi">choose any</span>{/if}
                  </div>
                  <p class="q-text">{q.question}</p>
                  <div class="opts">
                    {#each q.options as opt (opt.label)}
                      <button
                        class="opt"
                        class:sel={isPicked(q.question, opt.label)}
                        onclick={() => togglePick(q.question, opt.label, q.multiSelect)}
                      >
                        <span class="opt-label">{opt.label}</span>
                        {#if opt.description}<span class="opt-desc">{opt.description}</span>{/if}
                        {#if opt.preview}<pre class="opt-preview">{opt.preview}</pre>{/if}
                      </button>
                    {/each}
                  </div>
                  <input
                    class="q-other"
                    placeholder="Other… (type a custom answer)"
                    value={other[q.question] ?? ""}
                    oninput={(e) => setOther(q.question, e.currentTarget.value)}
                  />
                </div>
              {/each}
              <button class="q-submit" disabled={!canSubmit(aq)} onclick={() => submitAnswers(aq)}>
                Send answer{aq.questions.length > 1 ? "s" : ""} → agent
              </button>
            </section>
          {/if}

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
                <p class="label" title={g.label}>{g.label}</p>
                {#if g.pattern}
                  {@const pid = g.pattern.editIds[0] ?? ""}
                  {@const rep = editEvent(pid)}
                  <div class="edit">
                    <button class="edit-head" onclick={() => toggleCollapse(pid)}>
                      <span class="chev">{isCollapsed(pid) ? "▸" : "▾"}</span>
                      <span class="badge">⊟ {g.pattern.count} structurally identical edits</span>
                      <code>{filePath(rep?.payload)} + {g.pattern.count - 1} more</code>
                    </button>
                    {#if narrationFor(pid)}<p class="why-line">💬 {narrationFor(pid)}</p>{/if}
                    {#if !isCollapsed(pid)}
                      <DiffView toolName={rep?.toolName ?? ""} payload={rep?.payload} />
                    {/if}
                  </div>
                  {#each g.outliers as id (id)}
                    {@const e = editEvent(id)}
                    <div class="edit outlier">
                      <button class="edit-head" onclick={() => toggleCollapse(id)}>
                        <span class="chev">{isCollapsed(id) ? "▸" : "▾"}</span>
                        <span class="badge warn">⚠ differs from the pattern — worth a look</span>
                        <code>{filePath(e?.payload)}</code>
                      </button>
                      {#if narrationFor(id)}<p class="why-line">💬 {narrationFor(id)}</p>{/if}
                      {#if !isCollapsed(id)}<DiffView toolName={e?.toolName ?? ""} payload={e?.payload} />{/if}
                    </div>
                  {/each}
                {:else}
                  {#each g.editIds as id (id)}
                    {@const e = editEvent(id)}
                    <div class="edit">
                      <button class="edit-head" onclick={() => toggleCollapse(id)}>
                        <span class="chev">{isCollapsed(id) ? "▸" : "▾"}</span>
                        <code>{filePath(e?.payload)}</code>
                      </button>
                      {#if narrationFor(id)}<p class="why-line">💬 {narrationFor(id)}</p>{/if}
                      {#if !isCollapsed(id)}<DiffView toolName={e?.toolName ?? ""} payload={e?.payload} />{/if}
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

        {#if chatOpen}
          <button
            class="cdivider"
            class:dragging={chatDragging}
            aria-label="Resize conversation"
            style="top: {headerH + 12}px; height: calc(100dvh - {headerH + 24}px)"
            onpointerdown={chatDragStart}
            onpointermove={chatDragMove}
            onpointerup={chatDragEnd}
            onkeydown={chatDragKey}
          ></button>
          <aside
            class="right"
            class:dragging={chatDragging}
            style="top: {headerH + 12}px; width: {chatWidth}px"
          >
          <div class="chat-head">
            <h2>Conversation</h2>
            <button class="icon" title="Collapse conversation" onclick={() => setChatOpen(false)}>›</button>
          </div>
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
        {:else}
          <button
            class="chat-reveal"
            style="top: {headerH + 12}px"
            title="Show conversation"
            onclick={() => setChatOpen(true)}
          >‹ Chat</button>
        {/if}
      </div>
    {/if}
  </main>
</div>

<svelte:window onkeydown={onGlobalKey} />

{#if paletteOpen}
  <div class="overlay top">
    <button class="backdrop" aria-label="Close" onclick={closePalette}></button>
    <div class="palette" role="dialog" aria-modal="true">
      {#if paletteView === "theme"}
        <div class="palette-crumb">
          <button type="button" class="link-btn" onclick={exitThemeView}>‹ Back</button>
          <span>Theme — ↑/↓ to preview, Enter to apply, Esc to cancel</span>
        </div>
      {/if}
      <input
        class="palette-input"
        placeholder={paletteView === "theme"
          ? "Search themes…"
          : "Type a command — theme, diff layout, session…"}
        bind:value={paletteQuery}
        oninput={() => (paletteIndex = 0)}
        onkeydown={paletteKey}
        use:focusOnMount
      />
      <ul class="palette-list">
        {#each filtered as c, i (c.id)}
          <li>
            <button
              class="palette-item"
              class:sel={i === paletteIndex}
              onmouseenter={() => (paletteIndex = i)}
              onclick={() => runCommand(c)}
            >
              <span>{c.label}</span>
              {#if c.hint}<span class="palette-hint">{c.hint}</span>{/if}
            </button>
          </li>
        {/each}
        {#if filtered.length === 0}<li class="palette-empty">No matching commands</li>{/if}
      </ul>
    </div>
  </div>
{/if}

{#if showNew}
  <div class="overlay">
    <button class="backdrop" aria-label="Close" onclick={() => (showNew = false)}></button>
    <div class="modal" role="dialog" aria-modal="true">
      <h3>New session</h3>

      <label for="repo">Repository</label>
      <div class="repo-field">
        <input id="repo" bind:value={newRepo} placeholder="/path/to/repo" />
        <button type="button" onclick={pickFolder}>Choose folder…</button>
      </div>
      {#if recentFolders.length}
        <select
          class="recent"
          onchange={(e) => {
            if (e.currentTarget.value) newRepo = e.currentTarget.value;
            e.currentTarget.selectedIndex = 0;
          }}
        >
          <option value="">Recent folders…</option>
          {#each recentFolders as f (f)}<option value={f}>{f}</option>{/each}
        </select>
      {/if}

      <label for="task">Task</label>
      <textarea id="task" rows="6" bind:value={newTask} placeholder="Describe the work — multi-line is fine…"></textarea>

      <label class="check">
        <input type="checkbox" bind:checked={newWorktree} />
        Run in an isolated git worktree
      </label>

      <label class="check">
        <input type="checkbox" bind:checked={newPlan} />
        Plan mode (agent plans first; tools don't execute)
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

{#if showTheme}
  <div class="overlay">
    <button class="backdrop" aria-label="Close" onclick={() => (showTheme = false)}></button>
    <div class="modal" role="dialog" aria-modal="true">
      <h3>Import VSCode theme</h3>
      <p class="hint">Paste a VSCode color-theme JSON. It must include a <code>"name"</code>; <code>colors</code> theme the UI and <code>tokenColors</code> theme the code.</p>
      <textarea
        rows="10"
        bind:value={themeJson}
        placeholder={'{ "name": "My Theme", "type": "dark", "colors": {…}, "tokenColors": […] }'}
      ></textarea>
      {#if themeError}<p class="err">{themeError}</p>{/if}
      <div class="modal-actions">
        <button type="button" onclick={() => (showTheme = false)}>Cancel</button>
        <button type="button" class="primary" onclick={importTheme}>Import &amp; apply</button>
      </div>
    </div>
  </div>
{/if}

{#if showSettings}
  <div class="overlay">
    <button class="backdrop" aria-label="Close" onclick={() => (showSettings = false)}></button>
    <div class="modal settings" role="dialog" aria-modal="true">
      <h3>Settings</h3>

      <div class="set-row">
        <label for="set-theme">Theme</label>
        <div class="set-control">
          <select id="set-theme" value={theme.current} onchange={(e) => theme.select(e.currentTarget.value)}>
            {#each theme.available as t (t)}<option value={t}>{t}</option>{/each}
          </select>
          <button type="button" onclick={() => (showTheme = true)}>Import…</button>
        </div>
      </div>

      <div class="set-row">
        <span class="set-label">Diff layout</span>
        <div class="set-control">
          <button class="set-seg" class:on={diffMode.mode === "split"} onclick={() => diffMode.set("split")}>Side-by-side</button>
          <button class="set-seg" class:on={diffMode.mode === "unified"} onclick={() => diffMode.set("unified")}>Unified</button>
          <button class="set-seg" class:on={diffMode.mode === "ba"} onclick={() => diffMode.set("ba")}>Before/After</button>
        </div>
      </div>

      <div class="set-row">
        <label for="set-lines">Line numbers</label>
        <div class="set-control">
          <input id="set-lines" type="checkbox" checked={diffMode.lineNumbers} onchange={() => diffMode.toggleLineNumbers()} />
        </div>
      </div>

      <div class="set-row">
        <label for="set-uifont">UI font</label>
        <div class="set-control">
          <input id="set-uifont" list="ui-fonts" placeholder="default" value={settings.uiFont} oninput={(e) => settings.setUiFont(e.currentTarget.value)} />
        </div>
      </div>

      <div class="set-row">
        <span class="set-label">UI size</span>
        <div class="set-control">
          <button class="set-seg" class:on={settings.uiSize === "small"} onclick={() => settings.setUiSize("small")}>Small</button>
          <button class="set-seg" class:on={settings.uiSize === "medium"} onclick={() => settings.setUiSize("medium")}>Medium</button>
          <button class="set-seg" class:on={settings.uiSize === "large"} onclick={() => settings.setUiSize("large")}>Large</button>
        </div>
      </div>

      <div class="set-row">
        <label for="set-codefont">Code font</label>
        <div class="set-control">
          <input id="set-codefont" list="mono-fonts" placeholder="default" value={settings.codeFont} oninput={(e) => settings.setCodeFont(e.currentTarget.value)} />
        </div>
      </div>

      <div class="set-row">
        <label for="set-codesize">Code font size</label>
        <div class="set-control">
          <input id="set-codesize" type="number" min="9" max="28" value={settings.codeFontSize} oninput={(e) => settings.setCodeFontSize(Number(e.currentTarget.value))} />
          <span class="set-hint">px</span>
        </div>
      </div>

      <!-- UI font suggestions: installed families when detected, else sans/serif. -->
      <datalist id="ui-fonts">
        {#if installedFonts.length > 0}
          {#each installedFonts as f (f)}<option value={f}></option>{/each}
        {:else}
          <option value="system-ui"></option>
          <option value="Inter"></option>
          <option value="Segoe UI"></option>
          <option value="Roboto"></option>
          <option value="Helvetica Neue"></option>
          <option value="Arial"></option>
          <option value="ui-sans-serif"></option>
          <option value="Georgia"></option>
          <option value="ui-serif"></option>
          <option value="Times New Roman"></option>
        {/if}
      </datalist>
      <!-- Code font suggestions: installed families when detected, else monospace. -->
      <datalist id="mono-fonts">
        {#if installedFonts.length > 0}
          {#each installedFonts as f (f)}<option value={f}></option>{/each}
        {:else}
          <option value="JetBrains Mono"></option>
          <option value="Fira Code"></option>
          <option value="Cascadia Code"></option>
          <option value="SF Mono"></option>
          <option value="Menlo"></option>
          <option value="Monaco"></option>
          <option value="Consolas"></option>
          <option value="Source Code Pro"></option>
          <option value="IBM Plex Mono"></option>
          <option value="Courier New"></option>
          <option value="ui-monospace"></option>
        {/if}
      </datalist>

      <p class="set-hint">
        Type any font installed on your machine.
        {#if fontApiAvailable}
          <button type="button" class="link-btn" onclick={detectFonts}>
            {installedFonts.length > 0 ? `${installedFonts.length} installed fonts loaded` : "List my fonts"}
          </button>
        {/if}
      </p>

      <div class="modal-actions">
        <button type="button" class="primary" onclick={() => (showSettings = false)}>Done</button>
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
    position: sticky;
    top: 0;
    height: 100dvh;
    border-right: 1px solid var(--line);
    padding: 16px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    overflow: hidden;
    white-space: nowrap;
  }
  .tab-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
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
    color: var(--on-accent);
    border: 0;
    border-radius: 6px;
    padding: 8px;
    cursor: pointer;
    font: inherit;
    font-weight: 600;
    margin-bottom: 8px;
  }
  .tab {
    display: flex;
    align-items: center;
    border: 1px solid transparent;
    border-radius: 8px;
  }
  .tab:hover {
    background: var(--panel);
  }
  .tab.active {
    background: var(--panel);
    border-color: var(--accent);
  }
  .tab.dragging {
    opacity: 0.4;
  }
  .tab.over {
    box-shadow: inset 0 2px 0 var(--accent);
  }
  .tab-main {
    flex: 1;
    min-width: 0;
    text-align: left;
    background: transparent;
    border: 0;
    border-radius: 8px;
    padding: 8px 10px;
    cursor: pointer;
    color: var(--fg);
    font: inherit;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .t-badge {
    flex-shrink: 0;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 9px;
    background: var(--accent);
    color: var(--on-accent);
    font-size: 11px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .t-badge.ask {
    background: var(--warn);
    color: var(--on-warn);
  }
  .t-badge.plan {
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-size: 9px;
  }
  .tab-close {
    background: transparent;
    border: 0;
    color: var(--muted);
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 4px 9px;
    opacity: 0;
  }
  .tab:hover .tab-close {
    opacity: 0.7;
  }
  .tab-close:hover {
    opacity: 1;
    color: var(--danger);
  }
  .tab-rename {
    flex: 1;
    min-width: 0;
    margin: 4px;
    background: var(--bg, #0c0d12);
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: 6px 8px;
    color: var(--fg);
    font: inherit;
    font-size: 13px;
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

  .nav-footer {
    flex-shrink: 0;
    padding-top: 10px;
    display: flex;
    gap: 6px;
  }
  .settings-btn {
    flex: 1;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
    color: var(--fg);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    padding: 7px 8px;
    text-align: left;
  }
  .settings-btn:hover {
    border-color: var(--accent);
  }

  /* Settings panel */
  .set-row {
    display: grid;
    grid-template-columns: 110px 1fr;
    gap: 12px;
    align-items: center;
    margin: 12px 0;
  }
  .set-row > label,
  .set-label {
    color: var(--muted);
    font-size: 13px;
  }
  .set-control {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .set-control select,
  .set-control input:not([type]),
  .set-control input[type="number"] {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
    color: var(--fg);
    font: inherit;
    font-size: 13px;
    padding: 6px 8px;
    min-width: 0;
  }
  .set-control input[type="number"] {
    width: 64px;
  }
  .set-control input[list] {
    flex: 1;
  }
  .set-control select {
    flex: 1;
  }
  .set-control > button {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
    color: var(--fg);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    padding: 6px 10px;
  }
  .set-seg {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
    color: var(--muted);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    padding: 5px 9px;
  }
  .set-seg.on {
    color: var(--fg);
    border-color: var(--accent);
  }
  .set-hint {
    color: var(--muted);
    font-size: 11px;
  }
  .link-btn {
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    text-decoration: underline;
  }
  .hint {
    color: var(--muted);
    font-size: 12px;
    margin: 0 0 4px;
  }
  .hint code {
    color: var(--fg);
  }

  main {
    position: relative;
    max-width: 1140px;
    width: 100%;
    margin: 0 auto;
    padding: 0 24px 64px;
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
    position: sticky;
    top: 0;
    z-index: 20;
    max-height: 40vh;
    overflow-y: auto;
    background: var(--bg, #0c0d12);
    border-bottom: 1px solid var(--line);
    margin: 0 -24px 0;
    padding: 5px 24px;
  }
  header.shifted {
    padding-left: 52px;
  }
  .head-top {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .title {
    flex: 1;
    min-width: 0;
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .head-controls {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
  }
  .prompt-acc {
    margin-top: 3px;
  }
  .prompt-acc summary {
    cursor: pointer;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--muted);
  }
  .prompt-acc p {
    margin: 8px 0 2px;
    color: var(--muted);
    white-space: pre-wrap;
    border-left: 2px solid var(--line);
    padding-left: 12px;
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
    padding: 3px 12px;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
  }
  .dial.slowed {
    border-color: var(--warn);
    color: var(--warn);
  }
  .cols {
    display: flex;
    align-items: flex-start;
  }
  .cols.dragging {
    user-select: none;
    cursor: col-resize;
  }
  .left {
    flex: 1;
    min-width: 0;
  }
  .right {
    flex-shrink: 0;
    min-width: 0;
    padding-left: 16px;
    position: sticky;
    /* `top` and `width` are inline (measured header height + resizable width). */
  }
  /* Draggable divider between the diff area and the conversation. */
  .cdivider {
    flex-shrink: 0;
    width: 11px;
    align-self: stretch;
    position: sticky;
    background: transparent;
    border: 0;
    padding: 0;
    cursor: col-resize;
    z-index: 5;
  }
  .cdivider::after {
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
  .cdivider:hover::after,
  .cdivider:focus-visible::after,
  .cdivider.dragging::after {
    background: var(--accent);
    width: 3px;
  }
  .cdivider:focus {
    outline: none;
  }
  .chat-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .chat-reveal {
    flex-shrink: 0;
    position: sticky;
    align-self: flex-start;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    color: var(--muted);
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    padding: 8px 6px;
    writing-mode: vertical-rl;
  }
  .chat-reveal:hover {
    color: var(--fg);
    border-color: var(--accent);
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

  /* --- Agent plan (ExitPlanMode) --- */
  .plan {
    border: 1px solid var(--accent);
    border-radius: 10px;
    padding: 14px 16px;
    margin: 8px 0 14px;
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }
  .plan-title {
    margin: 0 0 10px;
    color: var(--accent);
  }
  .plan-body {
    margin: 0;
    max-height: 40vh;
    overflow: auto;
    white-space: pre-wrap;
    font-family: var(--code-font);
    font-size: var(--code-font-size);
    line-height: 1.5;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 10px 12px;
  }
  .plan-reason {
    width: 100%;
    margin-top: 10px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 7px 10px;
    color: var(--fg);
    font: inherit;
    resize: vertical;
    box-sizing: border-box;
  }
  .plan-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 8px;
  }
  .plan-changes {
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 8px;
    color: var(--fg);
    cursor: pointer;
    font: inherit;
    padding: 8px 14px;
  }
  .plan-changes:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .plan-approve {
    background: var(--accent);
    color: var(--on-accent);
    border: 0;
    border-radius: 8px;
    cursor: pointer;
    font: inherit;
    font-weight: 600;
    padding: 8px 16px;
  }

  /* --- Agent question --- */
  .question {
    border: 1px solid var(--accent);
    border-radius: 10px;
    padding: 14px 16px;
    margin: 8px 0 4px;
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }
  .q-title {
    margin: 0 0 10px;
    color: var(--accent);
  }
  .q {
    margin-bottom: 14px;
  }
  .q-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .q-chip {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 4px;
    padding: 1px 6px;
  }
  .q-multi {
    font-size: 10px;
    color: var(--muted);
    text-transform: uppercase;
  }
  .q-text {
    margin: 6px 0 10px;
    font-weight: 600;
  }
  .opts {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .opt {
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 12px;
    cursor: pointer;
    font: inherit;
    color: var(--fg);
  }
  .opt:hover {
    border-color: var(--accent);
  }
  .opt.sel {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 16%, var(--panel));
  }
  .opt-label {
    font-weight: 600;
  }
  .opt-desc {
    font-size: 12px;
    color: var(--muted);
  }
  .opt-preview {
    margin: 6px 0 0;
    font-size: 11px;
    color: var(--muted);
    white-space: pre-wrap;
    max-height: 160px;
    overflow: auto;
  }
  .q-other {
    margin-top: 8px;
    width: 100%;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 7px 10px;
    color: var(--fg);
    font: inherit;
    box-sizing: border-box;
  }
  .q-submit {
    background: var(--accent);
    color: var(--on-accent);
    border: 0;
    border-radius: 8px;
    padding: 9px 16px;
    cursor: pointer;
    font: inherit;
    font-weight: 600;
  }
  .q-submit:disabled {
    opacity: 0.5;
    cursor: default;
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
    color: var(--on-accent);
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
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .group .edit {
    margin-bottom: 8px;
  }
  .group .edit code {
    color: var(--muted);
    font-size: 12px;
  }
  .edit-head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: 0;
    padding: 2px 0;
    cursor: pointer;
    font: inherit;
  }
  .edit-head .chev {
    color: var(--accent);
    font-size: 11px;
    width: 12px;
    flex-shrink: 0;
  }
  .edit-head .badge {
    margin-right: 0;
  }
  .edit-head code {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    background: var(--bg);
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
    color: var(--on-accent);
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
  .overlay.top {
    align-items: flex-start;
    padding-top: 12vh;
  }
  .palette {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 560px;
    background: var(--bg, #0c0d12);
    border: 1px solid var(--line);
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
  }
  .palette-crumb {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--line);
    font-size: 11px;
    color: var(--muted);
  }
  .palette-input {
    width: 100%;
    border: 0;
    border-bottom: 1px solid var(--line);
    background: transparent;
    color: var(--fg);
    font: inherit;
    padding: 14px 16px;
    outline: none;
  }
  .palette-list {
    list-style: none;
    margin: 0;
    padding: 4px;
    max-height: 50vh;
    overflow-y: auto;
  }
  .palette-item {
    width: 100%;
    text-align: left;
    background: transparent;
    border: 0;
    border-radius: 6px;
    color: var(--fg);
    font: inherit;
    padding: 9px 12px;
    cursor: pointer;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
  }
  .palette-item.sel {
    background: var(--panel);
  }
  .palette-hint {
    color: var(--muted);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .palette-empty {
    color: var(--muted);
    font-style: italic;
    padding: 12px;
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
  .repo-field button {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 14px;
    color: var(--fg);
    cursor: pointer;
    font: inherit;
    white-space: nowrap;
  }
  .recent {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 7px 10px;
    color: var(--muted);
    font: inherit;
    font-size: 12px;
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
    color: var(--on-accent);
    border: 0;
    font-weight: 600;
  }
  .modal-actions .primary:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
