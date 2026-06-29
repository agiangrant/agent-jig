<script lang="ts">
import type {
  AgentProvider,
  DialMode,
  JigEvent,
  ProvidersInfo,
  RiskRule,
  Session,
  SessionConfig,
  SessionSummary,
} from "@agent-jig/contracts";
import { SvelteSet } from "svelte/reactivity";
import { alerts } from "./lib/alerts.svelte.ts";
import { JigConnection } from "./lib/connection.svelte.ts";
import { toHunks } from "./lib/diff.ts";
import { diffMode } from "./lib/diffMode.svelte.ts";
import { countAddsDels, rangeLabel } from "./lib/fileDiff.ts";
import AgentPicker from "./lib/AgentPicker.svelte";
import FileDiff from "./lib/FileDiff.svelte";
import FilePreview from "./lib/FilePreview.svelte";
import ImpactMap from "./lib/ImpactMap.svelte";
import Markdown from "./lib/Markdown.svelte";
import MarkdownInput from "./lib/MarkdownInput.svelte";
import ReviewPanel from "./lib/ReviewPanel.svelte";
import SkillsPanel from "./lib/SkillsPanel.svelte";
import {
  ensureDesktopFont,
  isTauri,
  listSystemFontsNative,
  pickFolderNative,
} from "./lib/platform.ts";
import { settings } from "./lib/settings.svelte.ts";
import { theme } from "./lib/theme.svelte.ts";

void theme.init(); // load custom themes + apply the saved selection's chrome
settings.apply(); // apply persisted fonts + tab size

// Desktop frameless shell: on macOS the Tauri window uses an overlay title bar
// (native traffic lights float over the webview), so reserve a top strip and a
// drag region. No-op in the browser / on other platforms.
const frameless =
  (isTauri && typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent)) ||
  // Dev-only preview of the frameless title bar in a plain browser (?frameless).
  (import.meta.env.DEV &&
    typeof location !== "undefined" &&
    new URLSearchParams(location.search).has("frameless"));
if (frameless) document.documentElement.dataset.frameless = "";

let showSettings = $state(false);
let settingsTab = $state<"agents" | "review" | "appearance" | "governance" | "tools">("agents");
let showSkills = $state(false);
let showTheme = $state(false);

// Font suggestions: the machine's actual installed families when the Local Font
// Access API is available (Chromium, on a user gesture); otherwise curated lists.
let installedFonts = $state<string[]>([]);
// The desktop shell exposes real installed fonts via a Rust command; in the
// browser we use Chromium's Local Font Access API (on a user gesture) if present.
const fontApiAvailable = isTauri || (typeof window !== "undefined" && "queryLocalFonts" in window);
async function detectFonts() {
  try {
    if (isTauri) {
      installedFonts = await listSystemFontsNative();
      return;
    }
    const q = (window as unknown as { queryLocalFonts?: () => Promise<Array<{ family: string }>> })
      .queryLocalFonts;
    if (!q) return;
    const data = await q.call(window);
    installedFonts = [...new Set(data.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
  } catch {
    /* permission denied / unavailable — keep the curated suggestions */
  }
}
// On the desktop there's no permission gate, so load the real font list eagerly.
if (isTauri) void detectFonts();
// WKWebView can't render arbitrary installed fonts via `font-family`; register
// the selected UI/code fonts as FontFaces so the choice actually takes effect.
// Re-runs whenever the selection changes.
$effect(() => {
  if (!isTauri) return;
  void ensureDesktopFont(settings.uiFont);
  void ensureDesktopFont(settings.codeFont);
});
let themeJson = $state("");
let themeError = $state("");
let themeDragOver = $state(false);
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
// Drop a theme file into the importer: load its text into the textarea so it can
// be edited before applying — don't import on drop.
async function onThemeDrop(e: DragEvent) {
  e.preventDefault();
  themeDragOver = false;
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  try {
    themeJson = await file.text();
    themeError = "";
  } catch (err) {
    themeError = (err as Error).message ?? "could not read file";
  }
}
function onThemeDragOver(e: DragEvent) {
  if (!e.dataTransfer?.types.includes("Files")) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  themeDragOver = true;
}

// In the Tauri desktop shell the Rust host injects the live sidecar port as a
// global before the app loads; in the browser this is absent and we use the
// dev env var or the page origin.
const wsBase = window.__JIG_WS_URL__ ?? import.meta.env.VITE_WS_URL ?? `ws://${location.host}`;
const httpBase = wsBase.replace(/^ws/, "http");

const conn = new JigConnection();

// Global governance config (risk rules, default dial, idle threshold), loaded from
// the server and editable in Settings. Drives the idle-alert threshold.
let config = $state<SessionConfig | null>(null);
async function loadConfig() {
  try {
    config = (await (await fetch(`${httpBase}/config`)).json()) as SessionConfig;
  } catch {
    /* server momentarily unavailable — keep the last/empty config */
  }
}
void loadConfig();

// Which agent providers this server can run, for the New Session modal + Settings.
let providers = $state<ProvidersInfo | null>(null);
async function loadProviders() {
  try {
    providers = (await (await fetch(`${httpBase}/providers`)).json()) as ProvidersInfo;
  } catch {
    /* server momentarily unavailable — keep the last/empty list */
  }
}
void loadProviders();

async function saveConfig() {
  if (!config) return;
  try {
    const res = await fetch(`${httpBase}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });
    if (!res.ok) {
      conn.lastError = "Couldn't save governance config.";
      return;
    }
    config = (await res.json()) as SessionConfig;
  } catch {
    conn.lastError = "Couldn't save governance config — is the server running?";
  }
}
function addRiskRule() {
  if (!config) return;
  const rule: RiskRule = {
    id: crypto.randomUUID(),
    glob: "**/example/**",
    defaultMode: "slowed",
    risk: 0.8,
  };
  config.riskRules = [...config.riskRules, rule];
}
function removeRiskRule(id: string) {
  if (!config) return;
  config.riskRules = config.riskRules.filter((r) => r.id !== id);
}

let sessions = $state<SessionSummary[]>([]);
let activeId = $state<string | null>(null);
let sidebarOpen = $state(true);

// --- Resizable / collapsible conversation column ---
const CHAT_W_KEY = "jig:chatWidth";
const CHAT_OPEN_KEY = "jig:chatOpen";
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
const ACTIVE_KEY = "jig:activeSession";
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

// Auto-clear a surfaced error after a few seconds (it can also be dismissed).
$effect(() => {
  if (conn.lastError === null) return;
  const t = setTimeout(() => {
    conn.lastError = null;
  }, 6000);
  return () => clearTimeout(t);
});

// --- Rename / close tabs ---
let editing = $state<string | null>(null);
let renameText = $state("");
function focusOnMount(node: HTMLInputElement | HTMLTextAreaElement) {
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
  try {
    await fetch(`${httpBase}/sessions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    await loadSessions();
  } catch {
    conn.lastError = "Couldn't rename the session — is the server running?";
  }
}
function renameKey(e: KeyboardEvent) {
  if (e.key === "Enter") commitRename();
  else if (e.key === "Escape") editing = null;
}
async function closeTab(s: Session) {
  const label = s.title ?? s.taskPrompt;
  if (!window.confirm(`Close "${label}"?\nThis removes the session and its history.`)) return;
  try {
    await fetch(`${httpBase}/sessions/${s.id}`, { method: "DELETE" });
    if (s.id === activeId) activeId = null;
    await loadSessions();
  } catch {
    conn.lastError = "Couldn't close the session — is the server running?";
  }
}

// --- Drag to reorder tabs (persisted locally) ---
const ORDER_KEY = "jig:tabOrder";
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
let newAgent = $state<AgentProvider>(settings.agentSdk);
let newModel = $state(settings.agentModel);
let creating = $state(false);
let createError = $state("");

// Recently-chosen repo folders, for quick re-selection (persisted locally).
const RECENT_KEY = "jig:recentFolders";
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

// Remember the last-used worktree/plan toggles so a new session opens with the
// same choices (the most recent repo is pre-selected from recentFolders).
const NEW_OPTS_KEY = "jig:newSessionOpts";
function loadNewOpts(): { worktree: boolean; plan: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(NEW_OPTS_KEY) ?? "{}");
    return { worktree: Boolean(v.worktree), plan: Boolean(v.plan) };
  } catch {
    return { worktree: false, plan: false };
  }
}
function saveNewOpts() {
  try {
    localStorage.setItem(NEW_OPTS_KEY, JSON.stringify({ worktree: newWorktree, plan: newPlan }));
  } catch {
    /* storage unavailable */
  }
}

// ⌘/Ctrl+Enter submits the New Session modal from any field.
function newModalKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    void createSession();
  }
}

function openNew() {
  const opts = loadNewOpts();
  newRepo = recentFolders[0] ?? ""; // pre-select the most recent project
  newTask = "";
  newWorktree = opts.worktree;
  newPlan = opts.plan;
  newAgent = settings.agentSdk;
  newModel = settings.modelFor(newAgent);
  createError = "";
  showNew = true;
}
async function pickFolder() {
  try {
    if (isTauri) {
      const path = await pickFolderNative();
      if (path) newRepo = path;
      return;
    }
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
        agentSdk: newAgent,
        agentModel: newModel.trim() || null,
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      createError = body.error ?? "Failed to create session.";
      return;
    }
    const s = (await res.json()) as Session;
    rememberFolder(newRepo.trim());
    saveNewOpts(); // remember worktree/plan choices for the next new session
    settings.setAgentSdk(newAgent); // remember the agent + its model for next time
    settings.setModelFor(newAgent, newModel.trim());
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

// --- Center workspace tabs (Observe → Understand → Steer, as three views) ---
let centerTab = $state<"feed" | "changes" | "activity" | "arch">("feed");
const reviewOpenCount = $derived(conn.reviewComments.filter((c) => !c.resolved).length);
const sessionDone = $derived(
  conn.session?.status === "done" || conn.session?.status === "error",
);

// Client-driven auto-review: when a session with auto-review enabled finishes,
// run the developer's configured default reviewer once (so it honors Settings).
// On a clean finish we also surface the Changes (review) tab.
let autoReviewedFor = $state<string | null>(null);
let switchedToChangesFor = $state<string | null>(null);
$effect(() => {
  const s = conn.session;
  if (!s || !sessionDone) return;
  if (s.autoReview && autoReviewedFor !== s.id && conn.reviewStatus.status === "idle") {
    if (!conn.reviewComments.some((c) => c.author !== "human")) {
      autoReviewedFor = s.id;
      conn.requestReview(
        settings.reviewerSdk,
        settings.reviewerModelFor(settings.reviewerSdk) || null,
        settings.reviewPrompt.trim() || null,
      );
    }
  }
  if (switchedToChangesFor !== s.id) {
    switchedToChangesFor = s.id;
    centerTab = "changes";
  }
});

// Load the repo file list + skills (for @file and /skill autocomplete) on connect.
// Refresh the provider list too, so a CLI installed since launch is detected.
$effect(() => {
  if (conn.connected && conn.session) {
    conn.requestFiles();
    conn.requestSkills();
    void loadProviders();
  }
});
// A blocking plan/question lives in the Review view — pull focus there so it's
// never hidden behind another tab.
$effect(() => {
  if (conn.plan || conn.question) centerTab = "feed";
});
// --- Attention alert: flash the session's tab + play the notification sound when
// a session newly needs the human. Driven off the cross-session summary so it
// covers background tabs too (not just the active one): a session "needs you" when
// it has a pending edit, a waiting question, or a plan to approve. We fire on the
// no-attention → attention transition (per session), so a burst is one alert and
// clearing it re-arms. The first summary seeds silently so we don't alarm on load.
const flashingTabs = new SvelteSet<string>();
const tabFlashTimers = new Map<string, ReturnType<typeof setTimeout>>();
const sessionNeedsHuman = new Map<string, boolean>();
let alertSeeded = false;
function needsHuman(s: SessionSummary): boolean {
  return s.pendingEdits > 0 || s.awaitingQuestion || s.awaitingPlan;
}
function flashTab(id: string): void {
  flashingTabs.add(id);
  const prev = tabFlashTimers.get(id);
  if (prev) clearTimeout(prev);
  tabFlashTimers.set(
    id,
    setTimeout(() => {
      flashingTabs.delete(id);
      tabFlashTimers.delete(id);
    }, 2400),
  );
}
$effect(() => {
  const summary = conn.summary;
  if (summary === null) return; // not loaded yet / mid-reconnect — keep prior state
  for (const s of summary) {
    const now = needsHuman(s);
    const before = sessionNeedsHuman.get(s.id) ?? false;
    if (alertSeeded && now && !before) {
      flashTab(s.id);
      const label = s.awaitingPlan
        ? "a plan is ready to review"
        : s.awaitingQuestion
          ? "a question is waiting"
          : "an edit is waiting for review";
      alerts.ping("Jig — review needed", `"${s.title ?? s.taskPrompt}": ${label}.`);
    }
    sessionNeedsHuman.set(s.id, now);
  }
  for (const id of [...sessionNeedsHuman.keys()]) {
    if (!summary.some((s) => s.id === id)) sessionNeedsHuman.delete(id);
  }
  alertSeeded = true;
});

// Pull the language-server registry + install state when Settings opens.
$effect(() => {
  if (showSettings) conn.requestLspServers();
});

// --- Sidebar session search (client-side filter over the rail) ---
let sessionFilter = $state("");
const visibleSessions = $derived.by(() => {
  const q = sessionFilter.trim().toLowerCase();
  if (!q) return orderedSessions;
  return orderedSessions.filter((s) =>
    `${s.title ?? ""} ${s.taskPrompt} ${s.repoPath}`.toLowerCase().includes(q),
  );
});

function editEvent(editId: string): JigEvent | undefined {
  return conn.events.find((e) => e.editId === editId && e.type === "tool_call");
}
function filePath(payload: unknown): string {
  return ((payload ?? {}) as { file_path?: string }).file_path ?? "";
}
/** The shell command a Bash tool_call ran (its payload is the raw tool input). */
function bashCommand(payload: unknown): string {
  return ((payload ?? {}) as { command?: string }).command ?? "";
}
/** A one-line "what did this tool do" detail for a tool_call: command, path, or pattern. */
function toolDetail(e: JigEvent): string {
  const tool = e.toolName ?? "";
  if (tool === "Bash") return bashCommand(e.payload);
  const p = filePath(e.payload);
  if (p) return p;
  return ((e.payload ?? {}) as { pattern?: string }).pattern ?? "";
}
function narrationFor(editId: string): string {
  const e = conn.events.find((x) => x.type === "narration" && x.editId === editId);
  return ((e?.payload ?? {}) as { text?: string }).text ?? "";
}

function outOfBand(p: unknown): { attributedTo: string; files: { path: string; kind: string }[] } {
  const v = (p ?? {}) as { attributedTo?: string; files?: { path: string; kind: string }[] };
  return { attributedTo: v.attributedTo ?? "external", files: v.files ?? [] };
}
function text(p: unknown): string {
  return ((p ?? {}) as { text?: string }).text ?? "";
}

// --- Architecture: files touched this session, grouped into a small tree ---
// Real data only (edits + out-of-band changes); the dependency/impact map is a
// later LSP-backed pass. Edit count per file drives the warm "N edits" badge.
const touchedTree = $derived.by(() => {
  const counts = new Map<string, number>();
  for (const e of conn.events) {
    if (e.type === "tool_call" && e.editId) {
      const p = filePath(e.payload);
      if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
    } else if (e.type === "out_of_band_change") {
      for (const f of outOfBand(e.payload).files) if (!counts.has(f.path)) counts.set(f.path, 0);
    }
  }
  const byDir = new Map<string, { name: string; path: string; edits: number }[]>();
  for (const [path, edits] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
    const slash = path.lastIndexOf("/");
    const dir = slash >= 0 ? path.slice(0, slash + 1) : "./";
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    (byDir.get(dir) ?? byDir.set(dir, []).get(dir))?.push({ name, path, edits });
  }
  return [...byDir].map(([dir, files]) => ({ dir, files }));
});
const touchedCount = $derived(touchedTree.reduce((n, g) => n + g.files.length, 0));

// The file whose impact map is shown in the Architecture tab. Focusing one asks
// the server for its 1-hop dependency neighborhood (computed lazily, on demand).
let focusedFile = $state<string | null>(null);
function focusFile(path: string): void {
  focusedFile = path;
  conn.requestImpact(path);
}
// Jump from a Review-tab edit straight to its impact map.
function showImpactFor(path: string): void {
  if (!path) return;
  centerTab = "arch";
  focusFile(path);
}

// --- Keyboard-driven review: focus a queued edit and drive ack/reject by key ---
let focusedEditId = $state<string | null>(null);
let showShortcuts = $state(false);

// Keep the focus on a still-pending edit; default to the first when it leaves.
$effect(() => {
  const q = conn.queue;
  if (q.length === 0) {
    if (focusedEditId !== null) focusedEditId = null;
  } else if (!q.some((e) => e.editId === focusedEditId)) {
    focusedEditId = q[0]?.editId ?? null;
  }
});
// Scroll the focused row into view as you move through the queue.
$effect(() => {
  if (focusedEditId === null) return;
  document.querySelector(`[data-edit="${focusedEditId}"]`)?.scrollIntoView({ block: "nearest" });
});

/** Ack every edit in the list that is still pending (others are ignored). */
function ackGroup(editIds: string[]) {
  const pending = new Set(conn.queue.map((e) => e.editId));
  for (const id of editIds) if (pending.has(id)) conn.ack(id);
}
function pendingInGroup(editIds: string[]): number {
  const pending = new Set(conn.queue.map((e) => e.editId));
  return editIds.filter((id) => pending.has(id)).length;
}

// --- Focused-edit review surface (one diff + its same-intent siblings) ---
const sessionId = $derived(conn.session?.id ?? activeId ?? "");
let contextOpen = $state(true); // Focus toggle: collapse the context rail
let previewPath = $state<string | null>(null);
let fileDiffRef = $state<{ scrollToChange: (d: 1 | -1) => void } | null>(null);
let expandedIntents = $state<Record<string, boolean>>({}); // open groups in "Edited this session"

// Leaving Review (or losing the queue) drops any open file preview.
$effect(() => {
  if (centerTab !== "feed") previewPath = null;
});

const focusedEvent = $derived(focusedEditId ? editEvent(focusedEditId) : undefined);
const focusedGroup = $derived(
  focusedEditId ? conn.changeView.find((g) => g.editIds.includes(focusedEditId)) : undefined,
);
const siblings = $derived(focusedGroup?.editIds ?? (focusedEditId ? [focusedEditId] : []));
const intentTitle = $derived(
  focusedGroup?.label || (focusedEditId ? narrationFor(focusedEditId) : "") || "Pending edit",
);
const focusedStats = $derived(
  focusedEvent
    ? countAddsDels(focusedEvent.toolName ?? "", focusedEvent.payload)
    : { adds: 0, dels: 0 },
);
const focusedRange = $derived(
  focusedEvent ? rangeLabel(toHunks(focusedEvent.toolName ?? "", focusedEvent.payload)) : "",
);
const focusedPath = $derived(filePath(focusedEvent?.payload));
const focusedChanges = $derived(
  focusedEvent ? toHunks(focusedEvent.toolName ?? "", focusedEvent.payload).length : 0,
);
const pendingInIntent = $derived(pendingInGroup(siblings));
const editPosInIntent = $derived.by(() => {
  const pend = conn.queue.filter((e) => siblings.includes(e.editId)).map((e) => e.editId);
  const i = pend.indexOf(focusedEditId ?? "");
  return i < 0 ? 1 : i + 1;
});

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i + 1) : "";
}
function baseOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}
/** Unique files touched by an intent group — the rail's "Edited this session". */
function groupFiles(editIds: string[]): string[] {
  const seen = new Set<string>();
  for (const id of editIds) {
    const p = filePath(editEvent(id)?.payload);
    if (p) seen.add(p);
  }
  return [...seen];
}
function toggleIntent(id: string) {
  expandedIntents[id] = !expandedIntents[id];
}
function previewFile(path: string) {
  if (path) previewPath = path;
}
function previewFileEvent(ev: JigEvent) {
  previewFile(filePath(ev.payload));
}
/** Click a sibling: focus it if still pending, otherwise preview its file. */
function focusSibling(id: string) {
  const pending = new Set(conn.queue.map((e) => e.editId));
  if (pending.has(id)) {
    focusedEditId = id;
    previewPath = null;
  } else {
    previewPath = filePath(editEvent(id)?.payload) || null;
  }
}
function statusOf(id: string): "current" | "pending" | "done" {
  if (id === focusedEditId) return "current";
  return conn.queue.some((e) => e.editId === id) ? "pending" : "done";
}
function addsDelsOf(id: string): { adds: number; dels: number } {
  const e = editEvent(id);
  return e ? countAddsDels(e.toolName ?? "", e.payload) : { adds: 0, dels: 0 };
}
// Real-time feed: edits that applied without gating (released or bypassed).
const realtimeFeed = $derived(
  conn.events.filter(
    (e) => e.type === "tool_call" && (e.gateState === "released" || e.gateState === "bypassed"),
  ),
);

// --- Inline reject-with-reason (the reason is handed to the agent to revise) ---
let rejectingEditId = $state<string | null>(null);
let rejectReason = $state("");
function startReject(editId: string) {
  rejectingEditId = editId;
  rejectReason = "";
}
function confirmReject() {
  if (rejectingEditId === null) return;
  conn.rejectEdit(rejectingEditId, rejectReason.trim());
  rejectingEditId = null;
  rejectReason = "";
}
function cancelReject() {
  rejectingEditId = null;
  rejectReason = "";
}

// --- Idle alert: surface (and notify about) edits that have waited too long ---
// The pacer stays pure; the UI owns the clock, timing each pending edit from its
// tool_call event timestamp. gateTimeoutMs (from config) is the alert threshold.
let now = $state(Date.now());
setInterval(() => {
  now = Date.now();
}, 15000);
const idleThreshold = $derived(config?.gateTimeoutMs ?? 30 * 60 * 1000);
function waitedMs(editId: string): number {
  const ts = editEvent(editId)?.ts;
  return ts ? now - ts : 0;
}
function waitedLabel(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "";
  if (mins < 60) return `waited ${mins}m`;
  return `waited ${Math.floor(mins / 60)}h ${mins % 60}m`;
}
const oldestIdle = $derived(
  conn.queue.map((e) => waitedMs(e.editId)).reduce((a, b) => Math.max(a, b), 0),
);

// --- Bottom status bar: live "now" telemetry over the event log ---
// A 1s clock so the elapsed timer ticks (the 15s `now` above is too coarse for it).
let clock = $state(Date.now());
setInterval(() => {
  clock = Date.now();
}, 1000);
// Session elapsed, freezing at endedAt once the session finishes. mm:ss (h:mm:ss past an hour).
const elapsedText = $derived.by(() => {
  const start = conn.session?.startedAt;
  if (!start) return "0:00";
  const ref = conn.session?.endedAt ?? clock;
  const secs = Math.max(0, Math.floor((ref - start) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
});
// The most recent event drives the live "now" line when nothing needs the human.
const lastEvent = $derived(conn.events.length ? conn.events[conn.events.length - 1] : undefined);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
function describeEvent(e: JigEvent): string {
  switch (e.type) {
    case "session_start":
      return "Session started";
    case "session_end":
      return "Session finished";
    case "reasoning": {
      const t = text(e.payload).replace(/\s+/g, " ").trim();
      return t ? (t.length > 80 ? `${t.slice(0, 80)}…` : t) : "Thinking…";
    }
    case "narration":
      return text(e.payload).trim() || "Working…";
    case "tool_call": {
      const tool = e.toolName ?? "tool";
      const base = filePath(e.payload) ? baseOf(filePath(e.payload)) : "";
      if (WRITE_TOOLS.has(tool)) return base ? `Editing ${base}` : "Editing files";
      if (tool === "Bash") {
        const cmd = bashCommand(e.payload).replace(/\s+/g, " ").trim();
        return cmd ? `$ ${cmd.length > 72 ? `${cmd.slice(0, 72)}…` : cmd}` : "Running a command";
      }
      if (tool === "Read") return base ? `Reading ${base}` : "Reading files";
      if (tool === "Grep" || tool === "Glob") return "Searching the codebase";
      return `${tool}…`;
    }
    case "tool_result":
      return "Processing results";
    case "directive":
      return "Steering directive sent";
    case "out_of_band_change":
      return "External change detected";
    case "ack":
      return "Edit approved";
    case "dial_change":
      return conn.mode === "slowed" ? "Switched to Slowed" : "Switched to Real-time";
    default:
      return "Working…";
  }
}
// The "now" line: attention first, then the latest activity.
const nowText = $derived.by(() => {
  const s = conn.session;
  if (!s) return "";
  if (s.status === "error") return "Session ended with an error";
  if (s.status === "done") return "Session finished";
  if (s.status === "paused") return "Paused — send a message to resume";
  if (conn.plan) return "Plan ready for your review";
  if (conn.question) return "Waiting on your answer";
  if (conn.mode === "slowed" && conn.queue.length > 0) {
    const n = conn.queue.length;
    return `Paused — ${n} edit${n > 1 ? "s" : ""} awaiting your review`;
  }
  return lastEvent ? describeEvent(lastEvent) : "Starting…";
});
// The spinner shows only while work is genuinely in-flight (not blocked on the human).
const agentBusy = $derived(
  conn.session?.status === "running" &&
    !conn.plan &&
    !conn.question &&
    !(conn.mode === "slowed" && conn.queue.length > 0),
);

/** True while a modal/overlay or the agent owns the keyboard — review keys defer. */
function reviewBlocked(): boolean {
  return (
    paletteOpen ||
    showNew ||
    showSettings ||
    showTheme ||
    showShortcuts ||
    editing !== null ||
    rejectingEditId !== null ||
    conn.question !== null ||
    conn.plan !== null
  );
}
function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

/** The review hotkeys, applied to the focused queue edit. Returns true if handled. */
function reviewKey(e: KeyboardEvent): boolean {
  const q = conn.queue;
  if (q.length === 0) return false;
  const idx = Math.max(
    0,
    q.findIndex((x) => x.editId === focusedEditId),
  );
  const cur = q[idx];
  switch (e.key) {
    case "j":
    case "ArrowDown":
      focusedEditId = q[Math.min(idx + 1, q.length - 1)]?.editId ?? null;
      return true;
    case "k":
    case "ArrowUp":
      focusedEditId = q[Math.max(idx - 1, 0)]?.editId ?? null;
      return true;
    case "a":
      if (cur) conn.ack(cur.editId);
      return true;
    case "A": // shift+a — ack the whole queue
      ackGroup(q.map((x) => x.editId));
      return true;
    case "r":
      if (cur) startReject(cur.editId);
      return true;
    case "n":
    case " ":
      fileDiffRef?.scrollToChange(1);
      return true;
    case "p":
      fileDiffRef?.scrollToChange(-1);
      return true;
    case "f":
      contextOpen = !contextOpen;
      return true;
    default:
      return false;
  }
}

// --- Conversation: ask the sidecar, or steer the agent ---
let message = $state("");
// Per-message model for the chat (Ask = second opinion). Null = the session's
// own provider/model (uses the fast persistent sidecar).
let chatProviderOverride = $state<AgentProvider | null>(null);
let chatModelOverride = $state<string | null>(null);
const chatProvider = $derived(chatProviderOverride ?? conn.session?.agentSdk ?? "claude");
const chatModel = $derived(chatModelOverride ?? conn.session?.agentModel ?? "");
// A directive can be anchored to a specific edit ("Re: your edit to X — …").
let anchorEditId = $state<string | null>(null);
const anchorPath = $derived(anchorEditId ? filePath(editEvent(anchorEditId)?.payload) : "");
function anchorTo(editId: string) {
  anchorEditId = editId;
  setChatOpen(true);
}
// A session whose agent has finished/stopped: sending a directive resumes it.
const stopped = $derived(conn.session != null && conn.session.status !== "running");
function ask() {
  const t = message.trim();
  if (!t) return;
  // Only send an override when the developer changed the picker, so the default
  // keeps using the fast persistent sidecar.
  conn.askSidecar(t, chatProviderOverride, chatModelOverride?.trim() || null);
  message = "";
}
function steer() {
  const t = message.trim();
  // Allow a send carrying only line comments (no typed message).
  if (!t && conn.lineComments.length === 0) return;
  conn.sendDirective(t, anchorEditId); // also ships + clears pending line comments
  message = "";
  anchorEditId = null;
}

// Pending line comments grouped by file, for the compose-bar tray. Each chip
// shows {basename}:{line}; clicking focuses that edit and scrolls to the line.
const commentGroups = $derived.by(() => {
  const groups = new Map<string, { path: string; comments: typeof conn.lineComments }>();
  for (const c of conn.lineComments) {
    let g = groups.get(c.path);
    if (g === undefined) {
      g = { path: c.path, comments: [] };
      groups.set(c.path, g);
    }
    g.comments.push(c);
  }
  return [...groups.values()];
});
function jumpToComment(c: (typeof conn.lineComments)[number]) {
  // Focus the commented edit so its diff (with the comment) is shown.
  if (conn.queue.some((p) => p.editId === c.editId)) focusedEditId = c.editId;
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
  { id: "skills", label: "Skills…", run: () => (showSkills = true) },
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
// --- Quick-nav: ⌘/Ctrl+1–3 switch main tabs, ⌥/Alt+1–9 switch sessions. While
// the modifier is held we show number hints on the targets (cleared on key-up or
// when the window loses focus). `code` (Digit1…) is used so ⌥ remapping the key
// on macOS doesn't matter. ---
const CENTER_TABS = ["feed", "changes", "activity", "arch"] as const;
let cmdHints = $state(false);
let altHints = $state(false);
function trackModifiers(e: KeyboardEvent): void {
  cmdHints = e.metaKey || e.ctrlKey;
  altHints = e.altKey;
}
function clearHints(): void {
  cmdHints = false;
  altHints = false;
}

function onGlobalKey(e: KeyboardEvent) {
  trackModifiers(e);
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit) {
    const idx = Number(digit[1]) - 1;
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const tab = CENTER_TABS[idx];
      if (tab) {
        e.preventDefault();
        centerTab = tab;
      }
      return;
    }
    if (e.altKey && !(e.metaKey || e.ctrlKey)) {
      const s = visibleSessions[idx];
      if (s) {
        e.preventDefault();
        select(s.id);
      }
      return;
    }
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === "p" || e.key === "k")) {
    e.preventDefault();
    openPalette();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === "n" || e.key === "N")) {
    e.preventDefault();
    openNew();
    return;
  }
  if (e.key === "Escape") {
    if (paletteOpen) {
      if (paletteView === "theme") exitThemeView();
      else closePalette();
      return;
    }
    if (rejectingEditId !== null) {
      cancelReject();
      return;
    }
    if (showShortcuts) {
      showShortcuts = false;
      return;
    }
    // The theme importer sits above Settings; close it first so Settings stays open.
    if (showTheme) {
      showTheme = false;
      return;
    }
    showNew = false;
    showSettings = false;
    return;
  }
  // Bare keystrokes drive review — but never while typing or a modal is up.
  if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e)) return;
  if (e.key === "?") {
    showShortcuts = !showShortcuts;
    return;
  }
  if (reviewBlocked()) return;
  if (reviewKey(e)) e.preventDefault();
}
</script>

{#if frameless && activeId === null}
  <!-- Empty draggable strip when no session is open. With a session, the
       header itself becomes the title bar (see header.as-titlebar). -->
  <div class="titlebar" data-tauri-drag-region></div>
{/if}

<div
  class="shell"
  class:dragging={dragging || chatDragging}
  class:has-status={activeId !== null}
  style="grid-template-columns: {sidebarOpen ? sidebarWidth : 0}px minmax(0, 1fr) {activeId !== null && chatOpen ? chatWidth : 0}px"
>
  <nav class="tabs" class:collapsed={!sidebarOpen}>
    <button class="newbtn" onclick={openNew}><span class="plus">+</span> New session</button>
    <div class="search">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
      <input placeholder="Search sessions" bind:value={sessionFilter} />
    </div>
    <div class="rail-label">Active</div>
    <div class="tab-list gv-scroll">
      {#each visibleSessions as s, i (s.id)}
      <!-- svelte-ignore a11y_no_static_element_interactions -- drag is a pointer-only
           enhancement; the inner buttons handle keyboard select/close -->
      <div
        class="tab"
        class:active={s.id === activeId}
        class:flash={flashingTabs.has(s.id)}
        class:dragging={dragId === s.id}
        class:over={overId === s.id && dragId !== null && dragId !== s.id}
        draggable={editing !== s.id}
        ondragstart={(e) => onDragStart(e, s.id)}
        ondragover={(e) => onDragOver(e, s.id)}
        ondrop={(e) => onDrop(e, s.id)}
        ondragend={onDragEnd}
      >
        {#if altHints && i < 9}<span class="kbd-num tab-hint">{i + 1}</span>{/if}
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
            <span class="t-top">
              <span class="dot {s.status}"></span>
              <span class="t-repo">{repoName(s.repoPath)}</span>
              <span class="t-status {s.status}">{s.status}</span>
            </span>
            <span class="t-task">{s.title ?? s.taskPrompt}</span>
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
      {#if visibleSessions.length === 0}
        <p class="rail-empty">{sessionFilter.trim() ? "No matching sessions." : "No sessions yet."}</p>
      {/if}
    </div>

    <div class="nav-footer">
      <button class="settings-btn" onclick={() => (showSkills = true)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M13 2 3 14h7l-1 8 10-12h-7z" /></svg>
        Skills
      </button>
      <button class="settings-btn" onclick={() => (showSettings = true)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
        Settings
      </button>
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

  <main class:session={activeId !== null}>
    {#if activeId === null}
      <p class="empty big">No session selected. Create one to start supervising.</p>
    {:else}
      <header class:as-titlebar={frameless} data-tauri-drag-region={frameless ? "" : undefined}>
        <div class="head-top" data-tauri-drag-region>
          <button
            class="head-toggle"
            class:on={sidebarOpen}
            title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            aria-label="Toggle sidebar"
            onclick={() => (sidebarOpen = !sidebarOpen)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>
          </button>
          <div class="crumb" data-tauri-drag-region>
            {#if conn.session?.repoPath}
              <span class="crumb-repo" data-tauri-drag-region>{repoName(conn.session.repoPath)}</span>
              <span class="crumb-sep" data-tauri-drag-region>/</span>
            {/if}
            <h1 class="title" data-tauri-drag-region>{conn.session?.title ?? conn.session?.taskPrompt ?? "Session"}</h1>
          </div>
          <div class="head-controls" data-tauri-drag-region>
            <span class="conn" class:on={conn.connected} data-tauri-drag-region>{conn.connected ? "live" : "reconnecting…"}</span>
            {#if conn.session?.status === "running"}
              <button
                class="stop"
                onclick={() => conn.stop()}
                title="Stop the agent — resume any time by sending a message"
              >■ Stop</button>
            {:else if conn.session}
              <span class="sess-status {conn.session.status}" data-tauri-drag-region>{conn.session.status}</span>
            {/if}
            <div class="throttle-wrap">
              <button
                class="throttle"
                class:slowed={conn.mode === "slowed"}
                onclick={toggle}
                aria-label="Toggle pacing mode"
                title="Slowed gates each write for your approval; Real-time applies edits automatically"
              >
                <span class="knob"></span>
                <span class="seg slow">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 7v5l3 2" /><circle cx="12" cy="12" r="9" /></svg>
                  Slowed
                </span>
                <span class="seg rt">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M13 2L4.5 13.5H11l-1 8.5L19.5 10H13z" /></svg>
                  Real-time
                </span>
              </button>
              {#if !frameless}<span class="throttle-sub">{conn.mode === "slowed" ? "Edits pause for your approval" : "Edits apply automatically"}</span>{/if}
            </div>
            <button
              class="head-toggle"
              class:on={chatOpen}
              title={chatOpen ? "Hide conversation" : "Show conversation"}
              aria-label="Toggle conversation"
              onclick={() => setChatOpen(!chatOpen)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
            </button>
          </div>
        </div>
      </header>

      <div class="ctabs">
        <button class="ctab" class:on={centerTab === "feed"} onclick={() => (centerTab = "feed")}>
          Feed
          {#if conn.queue.length > 0}<span class="ctab-badge warm">{conn.queue.length}</span>{/if}
          {#if cmdHints}<span class="kbd-num">1</span>{/if}
        </button>
        <button class="ctab" class:on={centerTab === "changes"} onclick={() => (centerTab = "changes")}>
          Changes
          {#if reviewOpenCount > 0}<span class="ctab-badge danger">{reviewOpenCount}</span>{/if}
          {#if cmdHints}<span class="kbd-num">2</span>{/if}
        </button>
        <button class="ctab" class:on={centerTab === "activity"} onclick={() => (centerTab = "activity")}>
          Activity
          {#if conn.events.length > 0}<span class="ctab-count">{conn.events.length}</span>{/if}
          {#if cmdHints}<span class="kbd-num">3</span>{/if}
        </button>
        <button class="ctab" class:on={centerTab === "arch"} onclick={() => (centerTab = "arch")}>
          Architecture
          {#if touchedCount > 0}<span class="ctab-count">{touchedCount}</span>{/if}
          {#if cmdHints}<span class="kbd-num">4</span>{/if}
        </button>
      </div>

      <section class="left">
          {#if centerTab === "changes"}
            <ReviewPanel {conn} {providers} />
          {/if}
          {#if centerTab === "feed"}
            {#if conn.plan}
              {@const pl = conn.plan}
              <div class="tab-scroll gv-scroll">
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
              </div>
            {:else if conn.question}
              {@const aq = conn.question}
              <div class="tab-scroll gv-scroll">
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
              </div>
            {:else}
              <div class="review-wrap">
                <!-- ===== Main review surface: one focused diff, its own scroll ===== -->
                <div class="surface" class:full={!contextOpen}>
                  {#if previewPath}
                    <FilePreview path={previewPath} base={httpBase} {sessionId} onClose={() => (previewPath = null)} />
                  {:else if conn.mode === "slowed" && conn.queue.length > 0 && focusedEvent}
                    <div class="surf-head">
                      <div class="sh-top">
                        <span class="gate-pill"><span class="blip"></span>EDIT GATED</span>
                        <span class="sh-pos">edit {editPosInIntent} / {pendingInIntent} in this intent</span>
                        <div class="sh-tools">
                          <div class="seg-group">
                            <button class="seg" class:on={diffMode.mode === "unified"} onclick={() => diffMode.set("unified")}>Unified</button>
                            <button class="seg" class:on={diffMode.mode === "split"} onclick={() => diffMode.set("split")}>Split</button>
                          </div>
                          <button class="focus-btn" class:on={!contextOpen} title="Focus — hide the context panel (f)" onclick={() => (contextOpen = !contextOpen)}>
                            {contextOpen ? "Focus" : "Context"}
                          </button>
                          <button class="kbd-hint" title="Keyboard shortcuts" onclick={() => (showShortcuts = true)}>?</button>
                        </div>
                      </div>
                      {#if oldestIdle >= idleThreshold}
                        <div class="idle-banner" role="alert">
                          ⏳ An edit has {waitedLabel(oldestIdle)} — the agent is blocked until you act on it.
                        </div>
                      {/if}
                      <div class="sh-title">{intentTitle}</div>
                      <div class="sh-file">
                        <span class="sh-dir">{dirOf(focusedPath)}</span><span class="sh-name">{baseOf(focusedPath)}</span>
                        {#if focusedRange}<span class="sh-range">{focusedRange}</span>{/if}
                        <span class="sh-stats"><span class="add">+{focusedStats.adds}</span><span class="del">−{focusedStats.dels}</span></span>
                      </div>
                    </div>

                    {#key focusedEditId}
                      <FileDiff
                        bind:this={fileDiffRef}
                        toolName={focusedEvent.toolName ?? ""}
                        payload={focusedEvent.payload}
                        path={focusedPath}
                        base={httpBase}
                        {sessionId}
                        comments={conn.lineComments.filter((c) => c.editId === focusedEditId)}
                        onAddComment={(c) =>
                          conn.addLineComment({
                            ...c,
                            id: crypto.randomUUID(),
                            editId: focusedEditId ?? "",
                            path: focusedPath,
                          })}
                        onRemoveComment={(id) => conn.removeLineComment(id)}
                      />
                    {/key}

                    {#if rejectingEditId === focusedEditId}
                      <form class="surf-reject" onsubmit={(e) => { e.preventDefault(); confirmReject(); }}>
                        <input
                          use:focusOnMount
                          bind:value={rejectReason}
                          placeholder="Reason for the agent (optional) — Enter to reject, Esc to cancel"
                          onkeydown={(e) => { if (e.key === "Escape") cancelReject(); }}
                        />
                        <button type="submit" class="reject">Reject</button>
                        <button type="button" onclick={cancelReject}>Cancel</button>
                      </form>
                    {/if}

                    <div class="surf-foot">
                      <div class="foot-nav">
                        <button class="navb" title="Previous change (p)" onclick={() => fileDiffRef?.scrollToChange(-1)} aria-label="Previous change">↑</button>
                        <button class="navb" title="Next change (n)" onclick={() => fileDiffRef?.scrollToChange(1)} aria-label="Next change">↓</button>
                        <span class="foot-count">{focusedChanges} change{focusedChanges === 1 ? "" : "s"}</span>
                      </div>
                      <div class="foot-actions">
                        <button class="steer-this" title="Steer the agent about this edit" onclick={() => focusedEditId && anchorTo(focusedEditId)}>⟲ Steer</button>
                        {#if pendingInIntent > 1}
                          <button class="approve-all" onclick={() => ackGroup(siblings)}>Approve all {pendingInIntent}</button>
                        {/if}
                        <button class="reject" onclick={() => focusedEditId && startReject(focusedEditId)}>Reject <span class="kbd">⌘⌫</span></button>
                        <button class="approve" onclick={() => focusedEditId && conn.ack(focusedEditId)}>Approve <span class="kbd">⌘↵</span></button>
                      </div>
                    </div>
                  {:else if conn.mode === "realtime"}
                    <div class="feed gv-scroll">
                      <div class="feed-head">
                        <span class="rt-pill"><span class="blip"></span>REAL-TIME</span>
                        <span class="feed-note">Edits apply automatically — switch to Slowed to gate them.</span>
                      </div>
                      {#if realtimeFeed.length === 0}
                        <p class="empty">No edits applied yet.</p>
                      {:else}
                        {#each realtimeFeed as ev (ev.id)}
                          {@const st = countAddsDels(ev.toolName ?? "", ev.payload)}
                          <button class="feed-row" onclick={() => previewFileEvent(ev)}>
                            <span class="feed-applied">✓ APPLIED</span>
                            <code class="feed-file">{baseOf(filePath(ev.payload))}</code>
                            <span class="feed-tool">{ev.toolName}</span>
                            <span class="feed-stats"><span class="add">+{st.adds}</span><span class="del">−{st.dels}</span></span>
                          </button>
                        {/each}
                      {/if}
                    </div>
                  {:else}
                    <div class="caught-up">
                      <div class="cu-check">✓</div>
                      <div class="cu-title">All edits reviewed</div>
                      <p class="cu-body">The agent is running — the next gated edit will appear here.</p>
                    </div>
                  {/if}
                </div>

                <!-- ===== Context rail: Related / Impact / Edited this session ===== -->
                {#if contextOpen && !previewPath}
                  <aside class="ctx-rail gv-scroll">
                    {#if focusedEvent && siblings.length > 0}
                      <div class="rail-h">Related · same intent</div>
                      {#each siblings as id (id)}
                        {@const e = editEvent(id)}
                        {@const st = addsDelsOf(id)}
                        <button class="sib" class:current={statusOf(id) === "current"} onclick={() => focusSibling(id)}>
                          <span class="sib-dot {statusOf(id)}"></span>
                          <span class="sib-label">{baseOf(filePath(e?.payload))}</span>
                          <span class="sib-stats"><span class="add">+{st.adds}</span><span class="del">−{st.dels}</span></span>
                        </button>
                      {/each}
                    {/if}

                    <div class="rail-h row">
                      Impact
                      <button class="rail-link" onclick={() => showImpactFor(filePath(e?.payload))}>Map →</button>
                    </div>
                    <p class="rail-note">See what this file's changes ripple to — who imports it, what it imports.</p>

                    <div class="rail-h">Edited this session</div>
                    {#if conn.changeView.length === 0}
                      <p class="rail-note">No edits yet.</p>
                    {:else}
                      {#each conn.changeView as g (g.id)}
                        {@const files = groupFiles(g.editIds)}
                        <div class="intent">
                          <button class="intent-head" onclick={() => toggleIntent(g.id)}>
                            <span class="chev">{expandedIntents[g.id] ? "▾" : "▸"}</span>
                            <span class="intent-label" title={g.label}>{g.label}</span>
                            <span class="intent-count">{files.length}</span>
                          </button>
                          {#if expandedIntents[g.id]}
                            {#each files as f (f)}
                              <button class="intent-file" onclick={() => previewFile(f)}>
                                <span class="if-name">{baseOf(f)}</span>
                                <span class="if-dir">{dirOf(f)}</span>
                              </button>
                            {/each}
                          {/if}
                        </div>
                      {/each}
                    {/if}
                  </aside>
                {/if}
              </div>
            {/if}
          {/if}

          {#if centerTab === "activity"}
            <div class="tab-scroll gv-scroll">
            <ol class="timeline">
              {#if conn.events.length === 0}
                <li class="empty">No activity yet — the agent hasn't acted.</li>
              {/if}
              {#each conn.events as ev (ev.id)}
                {#if ev.type === "out_of_band_change"}
                  <li class="tl oob">
                    <span class="tl-dot warn"></span>
                    <div class="tl-body">
                      <span class="tl-title warn">⚠ changed outside the agent <span class="tl-tag">{outOfBand(ev.payload).attributedTo}</span></span>
                      <span class="tl-text">{outOfBand(ev.payload).files.map((f) => f.path).join(", ")}</span>
                    </div>
                    <span class="seq">#{ev.seq}</span>
                  </li>
                {:else if ev.type === "reasoning"}
                  <li class="tl reason">
                    <span class="tl-dot"></span>
                    <div class="tl-body">
                      <span class="tl-title muted">Reasoning</span>
                      <span class="tl-text why">{text(ev.payload)}</span>
                    </div>
                    <span class="seq">#{ev.seq}</span>
                  </li>
                {:else if ev.type === "directive"}
                  <li class="tl directive">
                    <span class="tl-dot accent"></span>
                    <div class="tl-body">
                      <span class="tl-title accent">→ Steer</span>
                      <span class="tl-text">{text(ev.payload)}</span>
                    </div>
                    <span class="seq">#{ev.seq}</span>
                  </li>
                {:else}
                  {@const detail = ev.type === "tool_call" ? toolDetail(ev) : ""}
                  <li class="tl">
                    <span class="tl-dot {ev.gateState ?? ''}"></span>
                    <div class="tl-body">
                      <span class="tl-title">
                        {ev.type}
                        {#if ev.toolName}<span class="tool">{ev.toolName}</span>{/if}
                        {#if ev.gateState}<span class="gate {ev.gateState}">{ev.gateState}</span>{/if}
                      </span>
                      {#if detail}
                        <span class="tl-text mono" class:cmd={ev.toolName === "Bash"}>{detail}</span>
                      {/if}
                    </div>
                    <span class="seq">#{ev.seq}</span>
                  </li>
                {/if}
              {/each}
            </ol>
            </div>
          {/if}

          {#if centerTab === "arch"}
            <div class="arch-split">
              <div class="arch-rail gv-scroll">
                <div class="arch-head">Touched this session <span class="count">{touchedCount}</span></div>
                {#if touchedCount === 0}
                  <p class="empty">No files touched yet.</p>
                {:else}
                  <div class="arch-tree">
                    {#each touchedTree as g (g.dir)}
                      <div class="arch-dir">{g.dir}</div>
                      {#each g.files as f (f.path)}
                        <button
                          class="arch-file"
                          class:edited={f.edits > 0}
                          class:focused={focusedFile === f.path}
                          onclick={() => focusFile(f.path)}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>
                          <span class="arch-name">{f.name}</span>
                          {#if f.edits > 0}<span class="arch-edits">{f.edits} edit{f.edits > 1 ? "s" : ""}</span>{/if}
                        </button>
                      {/each}
                    {/each}
                  </div>
                {/if}
              </div>
              <ImpactMap
                map={conn.impactMap}
                loading={conn.impactLoading}
                onSelect={focusFile}
                onInstall={(serverId) => focusedFile && conn.installLsp(serverId, focusedFile)}
              />
            </div>
          {/if}
        </section>
    {/if}
  </main>

  <!-- Conversation: a top-level full-height column on the right, so the workspace
       header spans only the center — the chat is its own pane, not under it. -->
  {#if activeId !== null}
    {#if chatOpen}
      <button
        class="cdivider"
        class:dragging={chatDragging}
        aria-label="Resize conversation"
        style="right: {chatWidth}px"
        onpointerdown={chatDragStart}
        onpointermove={chatDragMove}
        onpointerup={chatDragEnd}
        onkeydown={chatDragKey}
      ></button>
      <aside class="right" class:dragging={chatDragging}>
        <div class="chat-head">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
          <h2>Conversation</h2>
        </div>
        <div class="chat gv-scroll">
          {#if conn.session?.taskPrompt}
            <div class="msg you">
              <span class="tag">you · task</span>
              {conn.session.taskPrompt}
            </div>
          {/if}
          {#each conn.conversation as m, i (i)}
            <div class="msg {m.role}">
              {#if m.role === "sidecar"}<span class="tag">sidecar</span>{/if}
              {#if m.role === "steer"}<span class="tag steer">→ sent to agent</span>{/if}
              <Markdown text={m.text} />
            </div>
          {/each}
        </div>
        <form class="compose" onsubmit={(e) => { e.preventDefault(); steer(); }}>
          {#if stopped}
            <p class="resume-hint">Stopped — send a message to resume where the agent left off.</p>
          {/if}
          {#if conn.lineComments.length > 0}
            <!-- Edit-anchored line comments, pending send. Kept in their own tray
                 (not the free-text input) so a later @mention slice can own that box. -->
            <div class="cmt-tray">
              <div class="cmt-tray-head">
                Comments on edits · {conn.lineComments.length}
              </div>
              {#each commentGroups as g (g.path)}
                <div class="cmt-file">
                  <span class="cmt-file-name" title={g.path}>{baseOf(g.path)}</span>
                  {#each g.comments as c (c.id)}
                    <button
                      type="button"
                      class="cmt-pin"
                      title={c.body}
                      onclick={() => jumpToComment(c)}>
                      :{c.line}
                      <span
                        class="cmt-pin-x"
                        role="button"
                        tabindex="-1"
                        aria-label="Remove comment"
                        onclick={(e) => { e.stopPropagation(); conn.removeLineComment(c.id); }}
                        onkeydown={(e) => { if (e.key === "Enter") { e.stopPropagation(); conn.removeLineComment(c.id); } }}
                        >✕</span>
                    </button>
                  {/each}
                </div>
              {/each}
            </div>
          {/if}
          {#if anchorEditId}
            <div class="anchor-chip">
              <span>Re: <code>{anchorPath || "this edit"}</code></span>
              <button type="button" aria-label="Clear anchor" onclick={() => (anchorEditId = null)}>✕</button>
            </div>
          {/if}
          <div class="compose-card">
            <MarkdownInput
              bind:value={message}
              files={conn.files}
              skills={conn.skills.map((s) => ({ name: s.name, description: s.description }))}
              placeholder={stopped ? "Send a message to resume…" : "Ask, steer, @file or /skill…"}
              onsubmit={steer}
            />
            <div class="actions">
              <AgentPicker
                compact
                placement="up"
                {providers}
                provider={chatProvider}
                model={chatModel}
                onpick={(p, m) => {
                  chatProviderOverride = p;
                  chatModelOverride = m;
                }}
              />
              <span class="actions-spacer"></span>
              <button type="button" class="ask" onclick={ask}>Ask</button>
              <button type="submit" class="send">{stopped ? "Resume" : "Send"}</button>
            </div>
          </div>
        </form>
      </aside>
    {/if}
  {/if}

  {#if activeId !== null}
    <!-- Bottom status bar: a full-width strip of live "now" telemetry over the
         event log, pinned to the viewport bottom *below* both side rails — pacing
         mode + current activity on the left, session metrics on the right. The
         rails reserve its height via --statusbar-h, so it never overlaps content. -->
    <div class="statusbar">
      <div class="sb-now">
        <span class="sb-dot" class:slowed={conn.mode === "slowed"}></span>
        <span class="sb-mode" class:slowed={conn.mode === "slowed"}>
          {conn.mode === "slowed" ? "Slowed" : "Real-time"}
        </span>
        <span class="sb-div"></span>
        {#if agentBusy}
          <svg class="sb-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.2-8.6" /></svg>
        {/if}
        <span class="sb-text" title={nowText}>{nowText}</span>
      </div>
      <div class="sb-right">
        <span class="sb-metric" title="Time elapsed this session">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
          {elapsedText}
        </span>
        <span class="sb-metric">{conn.events.length} event{conn.events.length === 1 ? "" : "s"}</span>
        {#if conn.mode === "slowed" && conn.queue.length > 0}
          <span class="sb-div"></span>
          <button class="sb-pending" onclick={() => (centerTab = "feed")} title="Go to feed">
            {conn.queue.length} pending
          </button>
        {/if}
      </div>
    </div>
  {/if}
</div>

<svelte:window onkeydown={onGlobalKey} onkeyup={trackModifiers} onblur={clearHints} />

{#if conn.lastError}
  <div class="toast" role="alert">
    <span>{conn.lastError}</span>
    <button class="toast-x" aria-label="Dismiss" onclick={() => (conn.lastError = null)}>✕</button>
  </div>
{/if}

{#if showShortcuts}
  <div class="overlay">
    <button class="backdrop" aria-label="Close" onclick={() => (showShortcuts = false)}></button>
    <div class="shortcuts" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <h2>Review shortcuts</h2>
      <dl>
        <div><dt>j / ↓</dt><dd>Next edit</dd></div>
        <div><dt>k / ↑</dt><dd>Previous edit</dd></div>
        <div><dt>a</dt><dd>Approve focused edit</dd></div>
        <div><dt>shift + a</dt><dd>Approve the whole queue</dd></div>
        <div><dt>r</dt><dd>Reject focused edit (with a reason)</dd></div>
        <div><dt>n / p / space</dt><dd>Next / previous change in the diff</dd></div>
        <div><dt>f</dt><dd>Focus — toggle the context panel</dd></div>
        <div><dt>⌘1–3</dt><dd>Switch Review / Activity / Architecture</dd></div>
        <div><dt>⌥1–9</dt><dd>Switch to session 1–9</dd></div>
        <div><dt>⌘K / ⌘P</dt><dd>Command palette</dd></div>
        <div><dt>⌘N</dt><dd>New session (⌘↵ to start)</dd></div>
        <div><dt>?</dt><dd>Toggle this help</dd></div>
      </dl>
    </div>
  </div>
{/if}

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
    <div class="modal" role="dialog" aria-modal="true" onkeydown={newModalKey}>
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
      <textarea id="task" rows="6" use:focusOnMount bind:value={newTask} placeholder="Describe the work — multi-line is fine…"></textarea>

      <div class="agent-row">
        <span class="set-label">Agent</span>
        <AgentPicker
          {providers}
          provider={newAgent}
          model={newModel}
          onpick={(p, m) => {
            newAgent = p;
            newModel = m;
          }}
        />
      </div>

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
        <button type="button" class="primary" disabled={creating} onclick={createSession} title="⌘/Ctrl+Enter">
          {creating ? "Creating…" : "Create"}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if showTheme}
  <!-- Elevated above Settings: the importer can be opened from within the Settings modal. -->
  <div class="overlay elevated">
    <button class="backdrop" aria-label="Close" onclick={() => (showTheme = false)}></button>
    <div
      class="modal"
      class:dragover={themeDragOver}
      role="dialog"
      aria-modal="true"
      ondragover={onThemeDragOver}
      ondragleave={() => (themeDragOver = false)}
      ondrop={onThemeDrop}
    >
      <h3>Import VSCode theme</h3>
      <p class="hint">Paste or drop a VSCode color-theme JSON file. It must include a <code>"name"</code>; <code>colors</code> theme the UI and <code>tokenColors</code> theme the code. Edit it below before applying.</p>
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

{#if showSkills}
  <div class="overlay">
    <button class="backdrop" aria-label="Close" onclick={() => (showSkills = false)}></button>
    <div class="modal skills-modal" role="dialog" aria-modal="true">
      <div class="skills-modal-head">
        <h3>Skills</h3>
        <button type="button" onclick={() => (showSkills = false)}>Close</button>
      </div>
      <SkillsPanel {conn} {providers} />
    </div>
  </div>
{/if}

{#if showSettings}
  <div class="overlay">
    <button class="backdrop" aria-label="Close" onclick={() => (showSettings = false)}></button>
    <div class="modal settings wide" role="dialog" aria-modal="true">
      <div class="set-head">
        <h3>Settings</h3>
        <button type="button" class="set-done" onclick={() => (showSettings = false)}>Done</button>
      </div>
      <div class="set-layout">
        <nav class="set-nav">
          <button class:on={settingsTab === "agents"} onclick={() => (settingsTab = "agents")}>Agents</button>
          <button class:on={settingsTab === "review"} onclick={() => (settingsTab = "review")}>Review</button>
          <button class:on={settingsTab === "appearance"} onclick={() => (settingsTab = "appearance")}>Appearance</button>
          {#if config}<button class:on={settingsTab === "governance"} onclick={() => (settingsTab = "governance")}>Governance</button>{/if}
          <button class:on={settingsTab === "tools"} onclick={() => (settingsTab = "tools")}>Tools</button>
        </nav>
        <div class="set-pane gv-scroll">

        {#if settingsTab === "agents"}
      <div class="set-row">
        <span class="set-label">Default agent</span>
        <div class="set-control">
          <AgentPicker
            {providers}
            provider={settings.agentSdk}
            model={settings.modelFor(settings.agentSdk)}
            align="right"
            onpick={(p, m) => {
              settings.setAgentSdk(p);
              settings.setModelFor(p, m);
            }}
          />
        </div>
      </div>

      <div class="set-row">
        <span class="set-label">Default reviewer</span>
        <div class="set-control">
          <AgentPicker
            {providers}
            provider={settings.reviewerSdk}
            model={settings.reviewerModelFor(settings.reviewerSdk)}
            align="right"
            onpick={(p, m) => {
              settings.setReviewerSdk(p);
              settings.setReviewerModelFor(p, m);
            }}
          />
        </div>
      </div>

      {#if providers}
        <p class="set-hint set-agents-hint">
          Sign in to each CLI (<code>codex login</code>; run <code>gemini</code> → Login with
          Google) or set an API key — read from the server environment.
          {#each providers.providers as p (p.id)}
            <span class="agent-status" class:off={!p.available}>
              {p.label}: {p.available ? "ready" : "not detected"}
            </span>
          {/each}
        </p>
      {/if}
        {/if}

        {#if settingsTab === "review"}
        <div class="set-row col">
          <span class="set-label">
            Custom review instructions
            <span class="set-hint">optional — replaces Jig's default reviewer guidance; the “post comments back to Jig” protocol is always injected</span>
          </span>
          <textarea
            class="review-prompt"
            rows="9"
            placeholder="e.g. Focus on security and error handling. Be terse; only flag real problems."
            value={settings.reviewPrompt}
            oninput={(e) => settings.setReviewPrompt(e.currentTarget.value)}
          ></textarea>
        </div>
        <p class="set-hint">
          The reviewer agent + model are set under
          <button type="button" class="link-btn" onclick={() => (settingsTab = "agents")}>Agents</button>.
        </p>
        {/if}

        {#if settingsTab === "appearance"}
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
        <label for="set-alerts">Sound &amp; flash alerts</label>
        <div class="set-control">
          {#if alerts.enabled && alerts.permission === "default"}
            <button type="button" onclick={() => alerts.requestPermission()}>Allow notifications</button>
          {:else if alerts.enabled && alerts.permission === "denied"}
            <span class="set-hint">Notifications blocked — using in-app sound</span>
          {/if}
          <input id="set-alerts" type="checkbox" checked={alerts.enabled} onchange={() => alerts.toggle()} />
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
        <span class="set-label">Density</span>
        <div class="set-control">
          <button class="set-seg" class:on={settings.density === "calm"} onclick={() => settings.setDensity("calm")}>Calm</button>
          <button class="set-seg" class:on={settings.density === "normal"} onclick={() => settings.setDensity("normal")}>Normal</button>
          <button class="set-seg" class:on={settings.density === "dense"} onclick={() => settings.setDensity("dense")}>Dense</button>
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
        {/if}

      {#if settingsTab === "governance" && config}
        <h4 class="set-section">Governance <span class="set-hint">— applies to new sessions/runs</span></h4>

        <div class="set-row">
          <span class="set-label">Default dial</span>
          <div class="set-control">
            <button class="set-seg" class:on={config.defaultMode === "slowed"} onclick={() => { if (config) config.defaultMode = "slowed"; }}>Slowed</button>
            <button class="set-seg" class:on={config.defaultMode === "realtime"} onclick={() => { if (config) config.defaultMode = "realtime"; }}>Real-time</button>
          </div>
        </div>

        <div class="set-row">
          <label for="set-idle">Idle alert after</label>
          <div class="set-control">
            <input
              id="set-idle"
              type="number"
              min="1"
              value={Math.round(config.gateTimeoutMs / 60000)}
              oninput={(e) => { if (config) config.gateTimeoutMs = Math.max(1, Number(e.currentTarget.value)) * 60000; }}
            />
            <span class="set-hint">min</span>
          </div>
        </div>

        <div class="set-row rules">
          <span class="set-label">Risk rules <span class="set-hint">glob → dial · risk</span></span>
          <div class="rule-list">
            {#each config.riskRules as rule (rule.id)}
              <div class="rule-row">
                <input class="rule-glob" bind:value={rule.glob} placeholder="**/auth/**" />
                <select bind:value={rule.defaultMode}>
                  <option value="slowed">slowed</option>
                  <option value="realtime">realtime</option>
                </select>
                <input class="rule-risk" type="number" min="0" max="1" step="0.05" bind:value={rule.risk} />
                <button type="button" class="rule-x" aria-label="Remove rule" onclick={() => removeRiskRule(rule.id)}>✕</button>
              </div>
            {/each}
            <button type="button" class="link-btn" onclick={addRiskRule}>+ Add rule</button>
          </div>
        </div>

        <div class="set-row">
          <span class="set-label"></span>
          <div class="set-control">
            <button type="button" onclick={saveConfig}>Save governance</button>
          </div>
        </div>
      {/if}

        {#if settingsTab === "tools"}
      <div class="set-row col">
        <span class="set-label">Language servers <span class="set-hint">code intelligence for the impact map</span></span>
        <div class="lsp-list">
          {#each conn.lspServers as s (s.serverId)}
            <div class="lsp-row">
              <span class="lsp-lang">{s.language}</span>
              {#if s.status === "installed"}
                <span class="lsp-ok">Installed</span>
              {:else if s.status === "installable"}
                <button type="button" class="lsp-install" disabled={s.installing} onclick={() => conn.installLsp(s.serverId)}>
                  {s.installing ? "Installing…" : "Install"}
                </button>
              {:else}
                <code class="lsp-hint" title="Run this in a terminal to install">{s.hint}</code>
              {/if}
            </div>
          {/each}
          {#if conn.lspServers.length === 0}<p class="set-hint">Loading…</p>{/if}
        </div>
      </div>
        {/if}

        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .shell {
    position: relative;
    display: grid;
    min-height: 100vh;
    /* Height reserved at the bottom for the fixed status bar; 0 unless a session
       is open (.has-status), so the side rails shrink to clear it. */
    --statusbar-h: 0px;
    transition: grid-template-columns 0.2s ease;
  }
  .shell.has-status {
    --statusbar-h: 36px;
  }
  .shell.dragging {
    transition: none;
    user-select: none;
    cursor: col-resize;
  }
  /* Frameless macOS title bar: a draggable strip the native traffic lights
     overlay. Sits above everything; app content clears it via --titlebar-h. */
  .titlebar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: var(--titlebar-h);
    z-index: 1000;
    background: var(--bg-1);
    border-bottom: 1px solid var(--border-soft);
    -webkit-app-region: drag;
  }
  .resizer {
    position: absolute;
    top: var(--titlebar-h);
    bottom: var(--statusbar-h, 0px);
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
    background: var(--border);
    transform: translateX(-50%);
    transition: background 0.15s, width 0.15s;
  }
  .resizer:hover::after,
  .resizer:focus-visible::after {
    background: var(--edge);
    width: 3px;
  }
  .resizer:focus {
    outline: none;
  }
  .tabs {
    position: sticky;
    top: var(--titlebar-h);
    height: calc(100dvh - var(--titlebar-h) - var(--statusbar-h, 0px));
    /* Grid items default to min-width:auto (min-content), which would keep a
       ~20px sliver when the column collapses to 0; pin it to 0 so it fully
       closes and clips. */
    min-width: 0;
    background: var(--bg-1);
    border-right: 1px solid var(--border);
    padding: var(--pad) var(--pad-sm);
    display: flex;
    flex-direction: column;
    gap: var(--gap-sm);
    overflow: hidden;
    white-space: nowrap;
  }
  /* Collapsed: also drop the padding + border (border-box keeps them ~19px wide
     even at width 0) so the rail closes completely. */
  .tabs.collapsed {
    padding-left: 0;
    padding-right: 0;
    border-right-width: 0;
  }
  .tab-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  /* Sidebar/conversation toggles, living in the workspace header. */
  .head-toggle {
    flex: none;
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-3);
    cursor: pointer;
    transition: background 0.18s ease, color 0.18s ease, border-color 0.18s ease;
  }
  .head-toggle:hover {
    background: var(--bg-3);
    color: var(--text);
  }
  .head-toggle.on {
    color: var(--text);
  }
  .newbtn {
    background: var(--accent);
    color: var(--on-accent);
    border: 0;
    border-radius: var(--radius-sm);
    padding: var(--pad-xs) var(--pad-sm);
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-sm);
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    transition: filter 0.15s ease, transform 0.1s ease;
  }
  .newbtn:hover {
    filter: brightness(1.08);
  }
  .newbtn:active {
    transform: translateY(1px);
  }
  .newbtn .plus {
    font-size: 14px;
    line-height: 0;
    font-weight: 500;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 7px var(--pad-sm);
    color: var(--text-3);
  }
  .search:focus-within {
    border-color: var(--accent);
  }
  .search input {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: 0;
    outline: none;
    color: var(--text);
    font: inherit;
    font-size: var(--fs-sm);
  }
  .search input::placeholder {
    color: var(--text-3);
  }
  .rail-label {
    font-size: var(--fs-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-3);
    font-weight: 600;
    padding: 8px 6px 2px;
  }
  .rail-empty {
    color: var(--text-3);
    font-size: var(--fs-sm);
    font-style: italic;
    padding: 8px;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex: none;
    background: var(--text-3);
  }
  .dot.running {
    background: var(--go);
    box-shadow: 0 0 0 3px var(--go-dim);
    animation: gv-pulse 1.6s ease-in-out infinite;
  }
  .dot.paused {
    background: var(--warm);
    box-shadow: 0 0 0 3px var(--warm-dim);
  }
  .dot.error {
    background: var(--danger);
    box-shadow: 0 0 0 3px var(--danger-2);
  }
  .t-top {
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .t-top .t-repo {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tab {
    position: relative;
    display: flex;
    align-items: center;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
  }
  /* Number hint chips shown while ⌘/⌥ is held (quick-nav). */
  .kbd-num {
    font-family: var(--code-font, monospace);
    font-size: 10px;
    font-weight: 700;
    line-height: 1;
    padding: 2px 5px;
    border-radius: 4px;
    background: var(--accent);
    color: var(--bg);
  }
  .ctab .kbd-num {
    margin-left: 6px;
    vertical-align: middle;
  }
  .tab-hint {
    position: absolute;
    top: 50%;
    right: 8px;
    transform: translateY(-50%);
    z-index: 2;
    box-shadow: 0 0 0 3px var(--bg-2);
  }
  .tab:hover {
    background: var(--bg-3);
  }
  .tab.active {
    background: var(--bg-3);
    border-color: var(--accent-dim);
  }
  .tab.dragging {
    opacity: 0.4;
  }
  .tab.over {
    box-shadow: inset 0 2px 0 var(--accent);
  }
  /* Attention flash: a themed pulse on the tab of a session that newly needs the
     human. Follows the active theme via --accent; pulses a few times then rests
     (the static badge carries the lingering "still waiting" state). */
  .tab.flash {
    animation: gv-tab-flash 0.8s ease-in-out 3;
  }
  @keyframes gv-tab-flash {
    0%,
    100% {
      background: transparent;
      box-shadow: inset 0 0 0 0 transparent;
    }
    50% {
      background: var(--accent-dim);
      box-shadow: inset 0 0 0 1px var(--accent);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    /* No strobe — hold a static accent highlight for the flash window instead. */
    .tab.flash {
      animation: none;
      background: var(--accent-dim);
      box-shadow: inset 0 0 0 1px var(--accent);
    }
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
    border-radius: var(--radius-sm);
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
    color: var(--text-2);
    font-size: var(--fs-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding-left: 14px;
  }
  .t-status {
    margin-left: auto;
    font-size: var(--fs-xs);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .t-status.running {
    color: var(--ok);
  }
  .t-status.error {
    color: var(--danger);
  }
  .t-status.paused {
    color: var(--warn);
  }

  .nav-footer {
    flex-shrink: 0;
    margin: 0 calc(-1 * var(--pad-sm));
    display: flex;
  }
  .settings-btn {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 9px;
    background: transparent;
    border: 0;
    border-top: 1px solid var(--border-soft);
    color: var(--text-2);
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-sm);
    padding: var(--pad-sm) var(--pad);
    text-align: left;
    transition: background 0.18s ease;
  }
  .settings-btn:hover {
    background: var(--bg-2);
    color: var(--text);
  }

  /* Settings panel */
  .set-section {
    margin: var(--pad) 0 var(--gap-sm);
    padding-top: var(--pad-sm);
    border-top: 1px solid var(--border-soft);
    font-size: var(--fs);
    font-weight: 600;
  }
  .set-row.rules {
    align-items: start;
  }
  .set-row.col {
    grid-template-columns: 1fr;
    gap: var(--gap-sm);
  }
  .lsp-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .lsp-row {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    padding: 5px var(--pad-sm);
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .lsp-lang {
    flex: 1;
    font-size: var(--fs-sm);
    color: var(--fg);
  }
  .lsp-ok {
    font-size: var(--fs-xs);
    color: var(--go);
  }
  .lsp-install {
    background: var(--bg-2);
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    color: var(--accent);
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-sm);
    padding: 2px var(--pad-sm);
  }
  .lsp-install:disabled {
    border-color: var(--border);
    color: var(--muted);
    cursor: default;
  }
  .lsp-hint {
    font-family: var(--code-font);
    font-size: var(--fs-xs);
    color: var(--muted);
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rule-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .rule-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .rule-glob {
    flex: 1;
    min-width: 0;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--fg);
    font: inherit;
    font-size: var(--fs-sm);
    padding: var(--pad-xs) var(--pad-sm);
  }
  .rule-row select {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--fg);
    font: inherit;
    font-size: var(--fs-sm);
    padding: var(--pad-xs) var(--pad-xs);
  }
  .rule-risk {
    width: 56px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--fg);
    font: inherit;
    font-size: var(--fs-sm);
    padding: var(--pad-xs) var(--pad-xs);
  }
  .rule-x {
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    font: inherit;
    padding: 0 4px;
  }
  .rule-x:hover {
    color: var(--danger);
  }
  .modal.settings.wide { max-width: 780px; }
  .set-head { display: flex; align-items: center; justify-content: space-between; }
  .set-head h3 { margin: 0; }
  .set-done {
    background: var(--accent); color: var(--on-accent); border: 0;
    border-radius: var(--radius-sm); padding: var(--pad-xs) var(--pad);
    cursor: pointer; font: inherit; font-weight: 600;
  }
  .set-layout { display: flex; gap: var(--gap); flex: 1; min-height: 0; margin-top: var(--gap-sm); }
  .set-nav {
    flex: none; width: 132px; display: flex; flex-direction: column; gap: 2px;
    border-right: 1px solid var(--border-soft); padding-right: var(--gap-sm);
  }
  .set-nav button {
    text-align: left; background: none; border: 0; border-radius: var(--radius-sm);
    padding: var(--pad-xs) var(--pad-sm); cursor: pointer; font: inherit;
    color: var(--text-2); font-weight: 600;
  }
  .set-nav button:hover { background: var(--bg-2); color: var(--fg); }
  .set-nav button.on { background: var(--bg-3); color: var(--fg); }
  .set-pane { flex: 1; min-width: 0; overflow-y: auto; padding-right: var(--gap-sm); }
  .set-pane .set-row:first-child { margin-top: 0; }
  .review-prompt {
    width: 100%; box-sizing: border-box; resize: vertical;
    background: var(--bg-2); border: 1px solid var(--border); border-radius: var(--radius-sm);
    color: var(--fg); font: inherit; font-family: var(--code-font); font-size: var(--fs-sm);
    padding: var(--pad-xs) var(--pad-sm);
  }
  .set-row {
    display: grid;
    grid-template-columns: 110px 1fr;
    gap: var(--gap);
    align-items: center;
    margin: var(--gap) 0;
  }
  .set-row > label,
  .set-label {
    color: var(--muted);
    font-size: var(--fs);
  }
  .set-control {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    flex-wrap: wrap;
  }
  .set-control select,
  .set-control input:not([type]),
  .set-control input[type="number"] {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--fg);
    font: inherit;
    font-size: var(--fs);
    padding: var(--pad-xs) var(--pad-sm);
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
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--fg);
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-sm);
    padding: var(--pad-xs) var(--pad-sm);
  }
  .set-seg {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--muted);
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-sm);
    padding: var(--pad-xs) var(--pad-sm);
  }
  .set-seg.on {
    color: var(--fg);
    border-color: var(--accent);
  }
  .set-hint {
    color: var(--muted);
    font-size: var(--fs-xs);
  }
  .set-agents-hint {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-sm);
    margin: 0 0 var(--gap);
  }
  .agent-status {
    color: var(--ok);
  }
  .agent-status.off {
    color: var(--muted);
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
    width: 100%;
    margin: 0 auto;
    /* Top pad = title-bar reserve so the sticky header's natural position matches
       its sticky `top` (no overlap with the tab bar). 0 unless frameless. */
    padding: var(--titlebar-h) 24px 64px;
  }
  /* With a session open the center is a fixed-height flex column: the workspace
     header + tabs are pinned and each tab's content owns its own scroll region —
     so the Review diff scrolls in place instead of the whole page. */
  main.session {
    height: calc(100dvh - var(--titlebar-h) - var(--statusbar-h, 0px));
    margin-top: var(--titlebar-h);
    padding: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  main.session header {
    position: static;
    top: auto;
    max-height: none;
    margin: 0;
    flex: none;
  }
  main.session .ctabs {
    flex: none;
  }
  main.session .left {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  /* Scrollable tab bodies (Activity, Architecture, plan/question cards). */
  .tab-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 16px 24px 48px;
  }
  .empty.big {
    margin-top: 80px;
    text-align: center;
    font-size: 14px;
  }
  header {
    position: sticky;
    top: var(--titlebar-h);
    z-index: 20;
    max-height: 40vh;
    overflow-y: auto;
    background: var(--bg-1);
    border-bottom: 1px solid var(--border-soft);
    margin: 0 -24px 0;
    padding: var(--pad-sm) 24px;
  }
  /* Desktop (frameless macOS): the header IS the title bar — fixed full-width
     across the top, draggable, inset past the native traffic lights. Scoped
     under [data-frameless] to out-specify the redesign's `main.session header`. */
  :global([data-frameless]) header.as-titlebar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: var(--titlebar-h);
    max-height: var(--titlebar-h);
    z-index: 1000;
    margin: 0;
    padding: 0 14px 0 84px;
    overflow: visible;
    -webkit-app-region: drag;
  }
  header.as-titlebar .head-top {
    height: 100%;
  }
  /* Make the whole bar — including inert title text and gaps — draggable… */
  header.as-titlebar * {
    -webkit-app-region: drag;
  }
  /* …but keep the interactive controls (and their inner svg/spans) clickable. */
  header.as-titlebar button,
  header.as-titlebar button *,
  header.as-titlebar .throttle,
  header.as-titlebar .throttle *,
  header.as-titlebar input,
  header.as-titlebar a {
    -webkit-app-region: no-drag;
  }
  .head-top {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .crumb {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 9px;
  }
  .crumb-repo {
    font-size: var(--fs-sm);
    color: var(--text-3);
    font-weight: 500;
    flex: none;
  }
  .crumb-sep {
    color: var(--text-3);
    flex: none;
  }
  .title {
    min-width: 0;
    margin: 0;
    font-size: var(--fs-lg);
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
  .conn {
    font-size: var(--fs-xs);
    color: var(--muted);
    text-transform: uppercase;
  }
  .conn.on {
    color: var(--ok);
  }
  .toast {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 100;
    display: flex;
    align-items: center;
    gap: 12px;
    max-width: 480px;
    padding: 10px 14px;
    background: color-mix(in srgb, var(--danger) 18%, var(--panel));
    color: var(--fg);
    border: 1px solid var(--danger);
    border-radius: 8px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.3);
    font-size: 13px;
  }
  .toast-x {
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    padding: 0 2px;
    font-size: 13px;
  }
  .toast-x:hover {
    color: var(--fg);
  }
  /* Jig throttle — segmented Slowed ↔ Real-time toggle with a sliding knob. */
  .throttle-wrap {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
  }
  .throttle {
    position: relative;
    width: 214px;
    height: 38px;
    padding: 5px;
    display: flex;
    align-items: center;
    border-radius: 999px;
    border: 1px solid var(--go-2);
    background: var(--go-dim);
    cursor: pointer;
    font: inherit;
    transition: background 0.35s ease, border-color 0.35s ease;
  }
  .throttle.slowed {
    border-color: var(--warm-2);
    background: var(--warm-dim);
  }
  .throttle .knob {
    position: absolute;
    top: 5px;
    left: calc(50% + 0px);
    width: calc(50% - 5px);
    height: 28px;
    border-radius: 999px;
    background: var(--go);
    box-shadow: 0 2px 10px -2px var(--go);
    transition: left 0.34s cubic-bezier(0.34, 1.3, 0.5, 1), background 0.35s ease, box-shadow 0.35s ease;
  }
  .throttle.slowed .knob {
    left: 5px;
    background: var(--warm);
    box-shadow: 0 2px 10px -2px var(--warm);
  }
  .throttle .seg {
    position: relative;
    z-index: 1;
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    font-size: var(--fs-sm);
    font-weight: 700;
    letter-spacing: 0.02em;
    transition: color 0.3s ease;
  }
  .throttle .seg.slow {
    color: var(--text-3);
  }
  .throttle .seg.rt {
    color: var(--on-go);
  }
  .throttle.slowed .seg.slow {
    color: var(--on-warm);
  }
  .throttle.slowed .seg.rt {
    color: var(--text-3);
  }
  .throttle-sub {
    font-size: var(--fs-xs);
    font-weight: 500;
    color: var(--go);
    transition: color 0.3s ease;
  }
  .throttle.slowed ~ .throttle-sub,
  .slowed.throttle + .throttle-sub {
    color: var(--warm);
  }
  .stop {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 3px 12px;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
  }
  .stop:hover {
    color: var(--danger);
    border-color: var(--danger);
  }
  .sess-status {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: var(--muted);
  }
  .sess-status.paused {
    color: var(--warn);
  }
  .sess-status.error {
    color: var(--danger);
  }
  .left {
    min-width: 0;
  }

  /* ===== Review surface (focused diff) + context rail ===== */
  .review-wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    overflow: hidden;
  }
  .surface {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }
  .surf-head {
    flex: none;
    padding: var(--pad-sm) var(--pad);
    border-bottom: 1px solid var(--border-soft);
    background: var(--bg);
  }
  .sh-top {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .sh-pos {
    font-size: var(--fs-sm);
    color: var(--muted);
  }
  .sh-tools {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .seg-group {
    display: flex;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 2px;
  }
  .seg {
    border: none;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 5px;
    background: transparent;
    color: var(--muted);
  }
  .seg.on {
    background: var(--accent);
    color: var(--bg);
  }
  .focus-btn {
    border: 1px solid var(--line);
    background: var(--panel);
    color: var(--muted);
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    padding: 5px 11px;
    border-radius: 6px;
  }
  .focus-btn.on {
    color: var(--accent);
    border-color: var(--accent);
  }
  .sh-title {
    margin-top: 10px;
    font-size: var(--fs-lg);
    font-weight: 600;
    color: var(--fg);
    line-height: 1.4;
  }
  .sh-file {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 8px;
    font-family: var(--code-font);
    font-size: var(--fs-sm);
  }
  .sh-dir {
    color: var(--muted);
  }
  .sh-name {
    color: var(--fg);
    font-weight: 600;
  }
  .sh-range {
    color: var(--muted);
    opacity: 0.7;
  }
  .sh-stats {
    display: flex;
    gap: 8px;
    font-weight: 600;
  }
  .add {
    color: var(--ok, #4fd6a0);
  }
  .del {
    color: var(--danger);
  }
  .surf-foot {
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: var(--pad-sm) var(--pad);
    border-top: 1px solid var(--line);
    background: var(--bg-1);
  }
  .foot-nav {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .navb {
    width: 28px;
    height: 28px;
    border: 1px solid var(--line);
    background: var(--panel);
    color: var(--muted);
    border-radius: 7px;
    cursor: pointer;
    font: inherit;
  }
  .navb:hover {
    color: var(--fg);
  }
  .foot-count {
    font-size: var(--fs-xs);
    color: var(--muted);
    margin-left: 4px;
  }
  .foot-actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .foot-actions .steer-this {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--line);
    border-radius: 7px;
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-sm);
    font-weight: 500;
    padding: 8px 12px;
  }
  .foot-actions .steer-this:hover {
    color: var(--accent);
    border-color: var(--accent);
  }
  .approve,
  .approve-all,
  .foot-actions .reject {
    border-radius: 7px;
    cursor: pointer;
    font: inherit;
    font-weight: 600;
    font-size: var(--fs-sm);
    padding: 8px 16px;
    border: 1px solid transparent;
  }
  .approve {
    background: var(--ok, #4fd6a0);
    color: #06231a;
  }
  .approve:hover {
    filter: brightness(1.08);
  }
  .approve-all {
    background: transparent;
    color: var(--muted);
    border: none;
  }
  .approve-all:hover {
    color: var(--fg);
  }
  .foot-actions .reject {
    background: transparent;
    color: var(--danger);
    border-color: var(--danger);
  }
  .foot-actions .reject:hover {
    background: var(--diff-del-bg, rgba(224, 108, 117, 0.12));
  }
  .kbd {
    font-family: var(--code-font);
    font-size: 10px;
    opacity: 0.65;
  }
  .surf-reject {
    flex: none;
    display: flex;
    gap: 8px;
    padding: 8px var(--pad);
    border-top: 1px solid var(--line);
    background: var(--bg-1);
  }
  .surf-reject input {
    flex: 1;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
    color: var(--fg);
    font: inherit;
    font-size: 12px;
    padding: 6px 9px;
  }
  .surf-reject button {
    border: 1px solid var(--line);
    background: var(--panel);
    color: var(--fg);
    border-radius: 6px;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    padding: 6px 12px;
  }
  .surf-reject button.reject {
    color: var(--danger);
    border-color: var(--danger);
  }

  /* caught-up / realtime feed */
  .caught-up {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: 12px;
    padding: 60px 20px;
  }
  .cu-check {
    width: 54px;
    height: 54px;
    border-radius: 50%;
    background: var(--diff-add-bg, rgba(79, 214, 160, 0.15));
    color: var(--ok, #4fd6a0);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 24px;
  }
  .cu-title {
    font-size: 17px;
    font-weight: 600;
    color: var(--fg);
  }
  .cu-body {
    font-size: 13px;
    color: var(--muted);
    max-width: 360px;
    line-height: 1.6;
  }
  .feed {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--pad);
  }
  .feed-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 14px;
  }
  .rt-pill {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    background: var(--diff-add-bg, rgba(79, 214, 160, 0.15));
    color: var(--ok, #4fd6a0);
    border-radius: 999px;
    padding: 4px 11px;
    font-size: var(--fs-xs);
    font-weight: 700;
    letter-spacing: 0.04em;
  }
  .rt-pill .blip {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ok, #4fd6a0);
  }
  .feed-note {
    font-size: var(--fs-sm);
    color: var(--muted);
  }
  .feed-row {
    width: 100%;
    text-align: left;
    display: flex;
    align-items: center;
    gap: 12px;
    background: var(--bg-1);
    border: 1px solid var(--line);
    border-radius: 9px;
    padding: 9px 14px;
    margin-bottom: 8px;
    cursor: pointer;
    font: inherit;
  }
  .feed-row:hover {
    border-color: var(--accent);
  }
  .feed-applied {
    color: var(--ok, #4fd6a0);
    font-size: var(--fs-xs);
    font-weight: 700;
  }
  .feed-file {
    font-family: var(--code-font);
    font-size: var(--fs-sm);
    color: var(--fg);
  }
  .feed-tool {
    font-size: var(--fs-sm);
    color: var(--muted);
  }
  .feed-stats {
    margin-left: auto;
    display: flex;
    gap: 8px;
    font-family: var(--code-font);
    font-size: var(--fs-xs);
  }

  /* context rail */
  .ctx-rail {
    width: 308px;
    flex: none;
    border-left: 1px solid var(--border-soft);
    background: var(--bg);
    overflow-y: auto;
    padding: var(--pad);
  }
  .rail-h {
    font-size: var(--fs-xs);
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--muted);
    font-weight: 600;
    margin-bottom: 9px;
  }
  .rail-h.row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 18px;
  }
  .rail-link {
    border: none;
    background: none;
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--accent);
    text-transform: none;
    letter-spacing: 0;
  }
  .rail-note {
    font-size: var(--fs-xs);
    color: var(--muted);
    line-height: 1.5;
    margin: 0 0 12px;
  }
  .sib {
    width: 100%;
    text-align: left;
    display: flex;
    align-items: center;
    gap: 9px;
    border: 1px solid var(--line);
    background: var(--panel);
    border-radius: 8px;
    padding: 8px 10px;
    margin-bottom: 6px;
    cursor: pointer;
    font: inherit;
  }
  .sib:hover {
    background: var(--bg-1);
  }
  .sib.current {
    border-color: var(--accent);
  }
  .sib-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: none;
    background: var(--muted);
  }
  .sib-dot.current {
    background: var(--warn);
  }
  .sib-dot.done {
    background: var(--ok, #4fd6a0);
  }
  .sib-label {
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sib-stats {
    margin-left: auto;
    display: flex;
    gap: 6px;
    font-family: var(--code-font);
    font-size: var(--fs-xs);
  }
  .intent {
    margin-bottom: 4px;
  }
  .intent-head {
    width: 100%;
    text-align: left;
    display: flex;
    align-items: center;
    gap: 8px;
    border: none;
    background: none;
    cursor: pointer;
    font: inherit;
    padding: 6px 4px;
    color: var(--fg);
  }
  .intent-head .chev {
    color: var(--muted);
    flex: none;
  }
  .intent-label {
    font-size: var(--fs-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .intent-count {
    margin-left: auto;
    font-size: 10px;
    font-weight: 700;
    color: var(--muted);
    background: var(--panel);
    border-radius: 999px;
    padding: 1px 7px;
  }
  .intent-file {
    width: 100%;
    text-align: left;
    display: flex;
    align-items: baseline;
    gap: 8px;
    border: none;
    background: none;
    cursor: pointer;
    font: inherit;
    padding: 4px 4px 4px 24px;
    border-radius: 6px;
  }
  .intent-file:hover {
    background: var(--panel);
  }
  .if-name {
    font-family: var(--code-font);
    font-size: var(--fs-sm);
    color: var(--fg);
  }
  .if-dir {
    font-size: 10px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .right {
    /* A top-level full-height column (sibling of <main>), pinned like the left
       rail so the workspace header spans only the center — the chat is its own
       pane, not under the header. Width comes from the shell grid track,
       resized via .cdivider. A frozen flex column: fixed head + scrolling
       messages + pinned composer. */
    position: sticky;
    top: var(--titlebar-h);
    height: calc(100dvh - var(--titlebar-h) - var(--statusbar-h, 0px));
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg-1);
    border-left: 1px solid var(--border);
  }
  /* Draggable divider between the center and the conversation column; an
     absolute overlay centered on the column boundary (`right` is inline). */
  .cdivider {
    position: absolute;
    top: var(--titlebar-h);
    bottom: var(--statusbar-h, 0px);
    width: 11px;
    transform: translateX(50%);
    background: transparent;
    border: 0;
    padding: 0;
    cursor: col-resize;
    z-index: 25;
  }
  .cdivider::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: 1px;
    background: var(--border);
    transform: translateX(-50%);
    transition: background 0.15s, width 0.15s;
  }
  .cdivider:hover::after,
  .cdivider:focus-visible::after,
  .cdivider.dragging::after {
    background: var(--edge);
    width: 3px;
  }
  .cdivider:focus {
    outline: none;
  }
  .chat-head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: var(--pad-sm) var(--pad);
    border-bottom: 1px solid var(--border-soft);
  }
  .chat-head h2 {
    margin: 0;
  }

  h2 {
    font-size: var(--fs-sm);
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--muted);
    margin: var(--pad) 0 var(--gap-sm);
    display: flex;
    align-items: center;
    gap: 8px;
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
    border-radius: var(--radius);
    padding: var(--pad-sm) var(--pad);
    margin: var(--gap-sm) 0 var(--gap);
    background: var(--accent-2);
  }
  .plan-title {
    margin: 0 0 var(--gap-sm);
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
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: var(--pad-xs) var(--pad-sm);
  }
  .plan-reason {
    width: 100%;
    margin-top: var(--gap-sm);
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: var(--pad-xs) var(--pad-sm);
    color: var(--fg);
    font: inherit;
    resize: vertical;
    box-sizing: border-box;
  }
  .plan-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--gap-sm);
    margin-top: var(--gap-sm);
  }
  .plan-changes {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--fg);
    cursor: pointer;
    font: inherit;
    padding: var(--pad-xs) var(--pad);
  }
  .plan-changes:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .plan-approve {
    background: var(--accent);
    color: var(--on-accent);
    border: 0;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font: inherit;
    font-weight: 600;
    padding: var(--pad-xs) var(--pad);
  }

  /* --- Agent question --- */
  .question {
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    padding: var(--pad-sm) var(--pad);
    margin: var(--gap-sm) 0 var(--gap-sm);
    background: var(--accent-2);
  }
  .q-title {
    margin: 0 0 var(--gap-sm);
    color: var(--accent);
  }
  .q {
    margin-bottom: var(--gap);
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
    margin: 6px 0 var(--gap-sm);
    font-weight: 600;
  }
  .opts {
    display: flex;
    flex-direction: column;
    gap: var(--gap-sm);
  }
  .opt {
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: var(--pad-xs) var(--pad-sm);
    cursor: pointer;
    font: inherit;
    color: var(--fg);
  }
  .opt:hover {
    border-color: var(--accent);
  }
  .opt.sel {
    border-color: var(--accent);
    background: var(--accent-2);
  }
  .opt-label {
    font-weight: 600;
  }
  .opt-desc {
    font-size: var(--fs-sm);
    color: var(--muted);
  }
  .opt-preview {
    margin: 6px 0 0;
    font-size: var(--fs-xs);
    color: var(--muted);
    white-space: pre-wrap;
    max-height: 160px;
    overflow: auto;
  }
  .q-other {
    margin-top: var(--gap-sm);
    width: 100%;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: var(--pad-xs) var(--pad-sm);
    color: var(--fg);
    font: inherit;
    box-sizing: border-box;
  }
  .q-submit {
    background: var(--accent);
    color: var(--on-accent);
    border: 0;
    border-radius: var(--radius-sm);
    padding: var(--pad-xs) var(--pad);
    cursor: pointer;
    font: inherit;
    font-weight: 600;
  }
  .q-submit:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .kbd-hint {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: 50%;
    width: 20px;
    height: 20px;
    margin-left: 8px;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    line-height: 1;
    vertical-align: middle;
  }
  .shortcuts {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 420px;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--pad) var(--pad);
    box-shadow: var(--shadow);
  }
  .shortcuts h2 {
    margin: 0 0 var(--gap);
  }
  .shortcuts dl {
    margin: 0;
    display: grid;
    gap: 8px;
  }
  .shortcuts dl > div {
    display: flex;
    justify-content: space-between;
    gap: 16px;
  }
  .shortcuts dt {
    font-family: var(--code-font, monospace);
    color: var(--accent);
    white-space: nowrap;
  }
  .shortcuts dd {
    margin: 0;
    color: var(--muted);
    text-align: right;
  }
  .idle-banner {
    margin: var(--gap-sm) 0;
    padding: var(--pad-xs) var(--pad-sm);
    border-radius: var(--radius-sm);
    background: var(--warm-dim);
    border: 1px solid var(--warm-2);
    color: var(--fg);
    font-size: var(--fs);
  }
  .anchor-chip {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: var(--gap-sm);
    padding: var(--pad-xs) var(--pad-sm);
    background: var(--bg-2);
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    font-size: var(--fs-sm);
    color: var(--muted);
  }
  .anchor-chip code {
    color: var(--fg);
  }
  .anchor-chip button {
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    font: inherit;
  }
  .anchor-chip button:hover {
    color: var(--fg);
  }

  /* Pending edit-comments tray: dense, grouped by file, line numbers as chips. */
  .cmt-tray {
    margin-bottom: var(--gap-sm);
    padding: var(--pad-xs) var(--pad-sm);
    background: var(--bg-2);
    border: 1px solid var(--line);
    border-left: 2px solid var(--accent);
    border-radius: var(--radius-sm);
  }
  .cmt-tray-head {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    margin-bottom: var(--gap-sm);
  }
  .cmt-file {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    margin-top: 3px;
  }
  .cmt-file-name {
    font-size: var(--fs-sm);
    color: var(--fg);
    margin-right: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 45%;
  }
  .cmt-pin {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 5px;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 10px;
    color: var(--accent);
    font-family: var(--code-font);
    font-size: 11px;
    cursor: pointer;
  }
  .cmt-pin:hover {
    border-color: var(--accent);
  }
  .cmt-pin-x {
    color: var(--muted);
    font-size: 10px;
  }
  .cmt-pin-x:hover {
    color: var(--danger);
  }

  .tool {
    color: var(--muted);
    font-size: var(--fs-sm);
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

  .chat {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--gap-sm);
    padding: var(--pad);
  }
  .msg {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--pad-xs) var(--pad-sm);
    max-width: 88%;
    white-space: pre-wrap;
    font-size: var(--fs-sm);
    line-height: var(--leading);
  }
  .msg.you {
    align-self: flex-end;
    background: var(--accent-2);
    border-color: var(--accent-dim);
    border-bottom-right-radius: 3px;
  }
  .msg.steer {
    align-self: flex-end;
    background: var(--accent-2);
    border-color: var(--accent-dim);
    border-bottom-right-radius: 3px;
  }
  .msg.sidecar {
    align-self: flex-start;
    background: var(--bg-2);
    color: var(--text-2);
    border-bottom-left-radius: 3px;
  }
  .tag {
    display: block;
    font-size: var(--fs-xs);
    text-transform: uppercase;
    color: var(--text-3);
    margin-bottom: 2px;
  }
  .tag.steer {
    color: var(--accent);
  }

  .compose {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: var(--gap-sm);
    padding: var(--pad);
    border-top: 1px solid var(--border-soft);
  }
  .resume-hint {
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--warn);
  }
  /* The composer is a single card holding the input + the Ask/Send buttons. */
  .compose-card {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--pad-sm);
    transition: border-color 0.18s ease;
  }
  .compose-card:focus-within {
    border-color: var(--accent);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    margin-top: var(--gap-sm);
  }
  .actions button {
    flex: 0 0 auto;
    min-width: 4.5em;
    border-radius: var(--radius-sm);
    padding: var(--pad-xs) var(--pad);
    cursor: pointer;
    font: inherit;
    font-weight: 600;
  }
  .actions-spacer { flex: 1 1 auto; }
  .actions .ask {
    background: transparent;
    color: var(--fg);
    border: 1px solid var(--border);
  }
  .actions .ask:hover {
    background: var(--bg-3);
  }
  .actions .send {
    background: var(--accent);
    color: var(--on-accent);
    border: 0;
    font-weight: 700;
    transition: filter 0.15s ease;
  }
  .actions .send:hover {
    filter: brightness(1.08);
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
  .overlay.elevated {
    z-index: 60;
  }
  .palette {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 560px;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    box-shadow: var(--shadow);
  }
  .palette-crumb {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: var(--pad-xs) var(--pad-sm);
    border-bottom: 1px solid var(--border-soft);
    font-size: var(--fs-xs);
    color: var(--muted);
  }
  .palette-input {
    width: 100%;
    border: 0;
    border-bottom: 1px solid var(--border-soft);
    background: transparent;
    color: var(--fg);
    font: inherit;
    padding: var(--pad-sm) var(--pad);
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
    border-radius: var(--radius-sm);
    color: var(--fg);
    font: inherit;
    padding: var(--pad-xs) var(--pad-sm);
    cursor: pointer;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
  }
  .palette-item.sel {
    background: var(--bg-3);
  }
  .palette-hint {
    color: var(--muted);
    font-size: var(--fs-xs);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .palette-empty {
    color: var(--muted);
    font-style: italic;
    padding: var(--pad-sm);
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
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--pad) var(--pad);
    width: 100%;
    max-width: 560px;
    max-height: 86vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--gap-sm);
    box-shadow: var(--shadow);
  }
  .modal.skills-modal {
    max-width: 900px;
  }
  .skills-modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .skills-modal-head h3 { margin: 0; }
  .skills-modal-head button {
    background: var(--bg-2);
    border: 1px solid var(--border);
    color: var(--fg);
    border-radius: var(--radius-sm);
    padding: var(--pad-xs) var(--pad-sm);
    cursor: pointer;
    font: inherit;
  }
  .modal.dragover {
    border-color: var(--accent);
    box-shadow: var(--shadow), 0 0 0 1px var(--accent) inset;
  }
  .modal h3 {
    margin: 0 0 var(--gap-sm);
  }
  .modal label {
    font-size: var(--fs-sm);
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--muted);
    margin-top: var(--gap-sm);
  }
  .modal label.check {
    display: flex;
    align-items: center;
    gap: 8px;
    text-transform: none;
    letter-spacing: 0;
    font-size: var(--fs);
    color: var(--fg);
    cursor: pointer;
  }
  .repo-field {
    display: flex;
    gap: var(--gap-sm);
  }
  .agent-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--gap-sm);
  }
  .repo-field input {
    flex: 1;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: var(--pad-xs) var(--pad-sm);
    color: var(--fg);
    font: inherit;
    min-width: 0;
  }
  .repo-field button {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: var(--pad-xs) var(--pad);
    color: var(--fg);
    cursor: pointer;
    font: inherit;
    white-space: nowrap;
  }
  .recent {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: var(--pad-xs) var(--pad-sm);
    color: var(--muted);
    font: inherit;
    font-size: var(--fs-sm);
  }
  .modal textarea {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: var(--pad-sm) var(--pad-sm);
    color: var(--fg);
    font: inherit;
    resize: vertical;
  }
  .err {
    color: var(--danger);
    font-size: var(--fs);
    margin: 4px 0 0;
  }
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--gap-sm);
    margin-top: var(--gap);
  }
  .modal-actions button {
    border-radius: var(--radius-sm);
    padding: var(--pad-xs) var(--pad);
    cursor: pointer;
    font: inherit;
    background: var(--bg-2);
    border: 1px solid var(--border);
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

  /* --- Center workspace tabs --- */
  .ctabs {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 24px;
    margin: 0 -24px var(--gap);
    border-bottom: 1px solid var(--border-soft);
  }
  .ctab {
    position: relative;
    border: 0;
    background: none;
    cursor: pointer;
    font: inherit;
    font-size: var(--fs);
    font-weight: 600;
    color: var(--text-2);
    padding: 12px 14px;
    display: flex;
    align-items: center;
    gap: 8px;
    transition: color 0.2s ease;
  }
  .ctab:hover {
    color: var(--text);
  }
  .ctab.on {
    color: var(--accent);
  }
  .ctab.on::after {
    content: "";
    position: absolute;
    left: 10px;
    right: 10px;
    bottom: -1px;
    height: 2px;
    background: var(--accent);
    border-radius: 2px;
  }
  .ctab-badge {
    background: var(--warm);
    color: var(--on-warm);
    font-size: 10px;
    font-weight: 700;
    border-radius: 999px;
    min-width: 17px;
    height: 17px;
    padding: 0 5px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .ctab-badge.danger {
    background: var(--danger);
    color: #fff;
  }
  .ctab-count {
    color: var(--text-3);
    font-size: var(--fs-xs);
    font-weight: 600;
  }

  /* --- Activity timeline --- */
  .timeline {
    display: flex;
    flex-direction: column;
    animation: gv-fade 0.3s ease;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--pad-xs) var(--pad);
  }
  .tl {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    padding: var(--pad-xs) 0;
  }
  .tl + .tl {
    border-top: 1px solid var(--border-soft);
  }
  .tl-dot {
    margin-top: 5px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex: none;
    background: var(--text-3);
    box-shadow: 0 0 0 3px var(--bg-2);
  }
  .tl-dot.warn,
  .tl-dot.pending {
    background: var(--warm);
  }
  .tl-dot.accent {
    background: var(--accent);
  }
  .tl-dot.released {
    background: var(--go);
  }
  .tl-dot.rejected {
    background: var(--danger);
  }
  .tl-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .tl-title {
    font-size: var(--fs-sm);
    font-weight: 700;
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .tl-title.muted {
    color: var(--text-3);
    font-weight: 600;
  }
  .tl-title.warn {
    color: var(--warm);
  }
  .tl-title.accent {
    color: var(--accent);
  }
  .tl-text {
    font-size: var(--fs-sm);
    color: var(--text-2);
    line-height: var(--leading);
    white-space: pre-wrap;
  }
  .tl-text.why {
    color: var(--accent);
    font-style: italic;
    opacity: 0.9;
  }
  .tl-text.mono {
    font-family: var(--code-font);
    font-size: var(--fs-xs);
    color: var(--text-3);
    word-break: break-word;
  }
  /* A run Bash command: tinted panel with a leading prompt glyph. */
  .tl-text.cmd {
    color: var(--text-2);
    background: var(--bg-2);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    padding: 4px 8px;
    margin-top: 2px;
  }
  .tl-text.cmd::before {
    content: "$ ";
    color: var(--go);
    font-weight: 700;
  }
  .tl-tag {
    font-size: var(--fs-xs);
    color: var(--text-2);
    background: var(--bg-3);
    border-radius: 5px;
    padding: 1px 7px;
    font-weight: 600;
  }
  .timeline .seq {
    flex: none;
    color: var(--text-3);
    font-size: var(--fs-xs);
    font-family: var(--code-font);
  }

  /* --- Architecture (touched files + impact map) --- */
  .arch-split {
    flex: 1;
    display: flex;
    min-height: 0;
    animation: gv-fade 0.3s ease;
  }
  .arch-rail {
    width: 280px;
    flex: none;
    border-right: 1px solid var(--border-soft);
    padding: var(--pad);
    overflow-y: auto;
  }
  .arch-head {
    font-size: var(--fs-xs);
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-3);
    font-weight: 600;
    margin-bottom: var(--gap-sm);
    animation: gv-fade 0.3s ease;
  }
  .arch-tree {
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--pad-xs) var(--pad);
  }
  .arch-dir {
    font-family: var(--code-font);
    font-size: var(--fs-sm);
    color: var(--text-2);
    font-weight: 600;
    padding: 8px 6px 4px;
  }
  .arch-file {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 6px var(--pad-sm);
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    margin-bottom: 3px;
    color: var(--text-3);
    background: none;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .arch-file:hover {
    background: var(--hover);
  }
  .arch-file.edited {
    background: var(--bg-2);
  }
  .arch-file.focused {
    border-color: var(--accent);
  }
  .arch-name {
    font-family: var(--code-font);
    font-size: var(--fs-sm);
    color: var(--text-2);
  }
  .arch-file.edited .arch-name {
    color: var(--warm);
    font-weight: 600;
  }
  .arch-edits {
    margin-left: auto;
    font-size: 10px;
    font-weight: 700;
    color: var(--warm);
    background: var(--warm-dim);
    border-radius: 999px;
    padding: 1px 7px;
  }
  /* --- Gate-hero queue treatment --- */
  .gate-pill {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    background: var(--warm-dim);
    color: var(--warm);
    border: 1px solid var(--warm-2);
    border-radius: 999px;
    padding: 4px 11px;
    font-size: var(--fs-sm);
    font-weight: 700;
    letter-spacing: 0.02em;
    margin-left: 4px;
    vertical-align: middle;
  }
  .gate-pill .blip {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--warm);
    animation: gv-pulse 1.6s ease-in-out infinite;
  }

  /* --- Bottom status bar: fixed full-width strip below both side rails --- */
  .statusbar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 30;
    height: var(--statusbar-h, 36px);
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 14px;
    background: var(--bg-1);
    border-top: 1px solid var(--border);
  }
  .sb-now {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    flex: 1;
  }
  .sb-dot {
    width: 7px;
    height: 7px;
    flex: none;
    border-radius: 50%;
    background: var(--go);
    box-shadow: 0 0 0 3px var(--go-dim);
    animation: gv-pulse 1.6s ease-in-out infinite;
  }
  .sb-dot.slowed {
    background: var(--warm);
    box-shadow: 0 0 0 3px var(--warm-dim);
  }
  .sb-mode {
    flex: none;
    font-size: var(--fs-xs);
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--go);
  }
  .sb-mode.slowed {
    color: var(--warm);
  }
  .sb-div {
    width: 1px;
    height: 14px;
    flex: none;
    background: var(--border);
  }
  .sb-spin {
    flex: none;
    color: var(--text-3);
    animation: gv-spin 1.5s linear infinite;
  }
  .sb-text {
    font-size: var(--fs-sm);
    color: var(--text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sb-right {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: none;
  }
  .sb-metric {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-xs);
    color: var(--text-3);
    font-family: var(--code-font);
    white-space: nowrap;
  }
  .sb-pending {
    border: none;
    cursor: pointer;
    font: inherit;
    font-size: 10px;
    font-weight: 700;
    color: var(--on-warm);
    background: var(--warm);
    border-radius: 999px;
    padding: 2px 9px;
    transition: filter 0.15s ease;
  }
  .sb-pending:hover {
    filter: brightness(1.07);
  }
</style>
