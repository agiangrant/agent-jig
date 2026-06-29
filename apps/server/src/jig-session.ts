import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  type AdapterConfig,
  buildReviewPrompt,
  type ClaudeAdapterDeps,
  getSDKAdapter,
  parseReviewComments,
  type RunningSession,
  reviewerSystem,
  runJigSession,
  runReadOnly,
} from "@agent-jig/agent-host";
import {
  buildImpactMap,
  type CodeGraphProvider,
  descriptorById,
  installServer,
  LspCodeGraphProvider,
  listServerStatus,
  type SymbolRef,
} from "@agent-jig/codegraph";
import type {
  AgentProvider,
  ChangeView,
  ClientToServer,
  DialMode,
  FileSlice,
  ImpactMap,
  JigEvent,
  LineComment,
  PendingPlan,
  PendingQuestion,
  Question,
  ReviewComment,
  Session,
  SessionSummary,
} from "@agent-jig/contracts";
import {
  composeAllComments,
  composeEditFeedback,
  composeReviewFeedback,
  groupByIntent,
  groupCommentsByEdit,
  isWriteClass,
  Pacer,
} from "@agent-jig/core";
import type { Narrator } from "@agent-jig/narrator";
import { SIDECAR_SYSTEM, Sidecar } from "@agent-jig/sidecar";
import type { Storage } from "@agent-jig/store";
import type { StructuralAnalyzer } from "@agent-jig/structural";
import { Worktree } from "@agent-jig/worktree";
import type { WebSocket } from "ws";
import { Broadcaster } from "./broadcaster.ts";
import { buildChangeView, visibleEvents } from "./changeView.ts";
import { listSkills, SKILL_AUTHOR_SYSTEM, saveSkill } from "./skills.ts";

export interface JigSessionDeps {
  session: Session;
  mode?: DialMode;
  store: Storage;
  analyzer: StructuralAnalyzer | null;
  narrator: Narrator | null;
  queryImpl?: ClaudeAdapterDeps["queryImpl"];
  /** Per-provider adapter credentials (gemini/codex API keys), from server config. */
  adapterConfig?: AdapterConfig;
  /** Resume a prior SDK session (cross-process) instead of starting the agent fresh. */
  resumeClaudeId?: string;
  /** View-only rehydration: reconnect to stored state without running an agent. */
  detached?: boolean;
  /** Start the agent in plan mode (plans; tools don't execute). */
  planMode?: boolean;
  /** Fired when this session's attention state changes (queue/question/clients). */
  onAttention?: () => void;
  /** Inject a code-graph provider (tests); defaults to a lazily-created LSP-backed one. */
  impactProvider?: CodeGraphProvider;
}

/** Stand-in for a session with no live agent (detached/view-only rehydration). */
const INERT_RUNNING: RunningSession = {
  result: Promise.resolve(),
  sendDirective: () => {},
  setPermissionMode: async () => {},
  interrupt: async () => {},
};

/** First message when resuming on restart — history already holds the task. */
const RESUME_NUDGE = "Resume the task you were working on; continue where you left off.";

/** A compact transcript of the agent's activity, for the sidecar's context. */
function buildTranscript(events: JigEvent[]): string {
  const lines: string[] = [];
  for (const e of events) {
    if (e.type === "reasoning") {
      lines.push(`AGENT THOUGHT: ${((e.payload ?? {}) as { text?: string }).text ?? ""}`);
    } else if (e.type === "tool_call" && e.toolName) {
      const path = ((e.payload ?? {}) as { file_path?: string }).file_path;
      lines.push(`AGENT TOOL: ${e.toolName}${path ? ` ${path}` : ""}`);
    } else if (e.type === "directive") {
      lines.push(`DEVELOPER STEERED: ${((e.payload ?? {}) as { text?: string }).text ?? ""}`);
    }
  }
  const text = lines.join("\n");
  return text.length > 6000 ? text.slice(-6000) : text;
}

/**
 * One governed agent session: its own pacer, agent host, sidecar, worktree, and
 * broadcaster. Clients attach over a per-session websocket; control messages are
 * scoped to this session by the connection. The store, analyzer, and narrator
 * are shared across sessions by the manager.
 */
export class JigSession {
  readonly id: string;
  private readonly repoPath: string;
  private readonly store: Storage;
  private session: Session;
  private readonly queryImpl: ClaudeAdapterDeps["queryImpl"];
  private readonly adapterConfig: AdapterConfig;
  private readonly analyzer: StructuralAnalyzer | null;
  private readonly pacer: Pacer;
  private readonly broadcaster = new Broadcaster();
  private running: RunningSession;
  /** Whether a live agent run is in flight (vs finished/stopped/detached). */
  private live = false;
  /** Set when the human asks to stop, so the finished run settles to `paused`. */
  private stopRequested = false;
  private readonly sidecar: Sidecar;
  private readonly narrator: Narrator | null;
  /** Generated intent labels, keyed by group id (first edit). */
  private readonly intentLabels = new Map<string, string>();
  private readonly intentPending = new Set<string>();
  /** The agent's open question (if any) and the resolver that answers it. */
  private question: PendingQuestion | null = null;
  private answerQuestion: ((message: string) => void) | null = null;
  /** The agent's open plan (if any) and the resolver that decides it. */
  private plan: PendingPlan | null = null;
  private decidePlan: ((d: { approved: boolean; message?: string }) => void) | null = null;
  /** Set once the human renames the session, so the LLM title won't overwrite it. */
  private titleManual = false;
  private readonly onAttention: (() => void) | undefined;
  /** Lazily-created code-graph provider (tree-sitter + LSP); only on first focus. */
  private impactProviderPromise: Promise<CodeGraphProvider> | null = null;
  /** Computed impact maps, keyed by focused path; cleared when any edit lands. */
  private readonly impactCache = new Map<string, ImpactMap>();
  /** A test-injected provider, if any (else the LSP-backed one is created lazily). */
  private readonly injectedProvider: CodeGraphProvider | undefined;

  constructor(deps: JigSessionDeps) {
    this.id = deps.session.id;
    this.repoPath = deps.session.repoPath;
    this.store = deps.store;
    this.session = deps.session;
    this.queryImpl = deps.queryImpl;
    this.adapterConfig = deps.adapterConfig ?? {};
    this.analyzer = deps.analyzer;
    this.narrator = deps.narrator;
    this.onAttention = deps.onAttention;
    this.injectedProvider = deps.impactProvider;
    const detached = deps.detached ?? false;
    // Restore the dial from the last change so a reconnected session keeps its pace.
    this.pacer = new Pacer(deps.mode ?? this.restoreMode() ?? deps.store.getConfig().defaultMode);

    this.pacer.onQueueChange = (pending) => {
      this.broadcaster.broadcast({ type: "queue_state", pending });
      this.onAttention?.(); // a queued/acked edit changes this tab's badge
    };
    this.pacer.onModeChange = (mode) => {
      this.store.appendEvent({ sessionId: this.id, type: "dial_change", payload: { mode } });
      this.broadcaster.broadcast({ type: "dial_state", mode });
    };

    if (detached) {
      this.running = INERT_RUNNING; // view-only; resume() can later revive it
    } else {
      // Fresh: the task prompt is the opening turn. Restart-resume: history holds
      // the task, so nudge it to continue.
      const firstMessage = deps.resumeClaudeId ? RESUME_NUDGE : deps.session.taskPrompt;
      this.running = this.startRunner(firstMessage, deps.resumeClaudeId, deps.planMode);
    }

    this.sidecar = new Sidecar({ repoPath: this.repoPath, queryImpl: deps.queryImpl });
    // Only brand-new sessions need a title generated; rehydrated ones already have one.
    if (!detached && deps.resumeClaudeId === undefined) this.initTitle(deps.session.taskPrompt);
  }

  /** Broadcast a stored event and refresh derived views/narration. */
  private handleEvent(event: JigEvent): void {
    this.broadcaster.broadcast({ type: "event", event });
    if (event.type === "reasoning" || event.type === "tool_call") this.broadcastChangeView();
    // A rejection removes an edit from the change view — rebuild so it drops out.
    else if (event.type === "ack" && event.gateState === "rejected") this.broadcastChangeView();
    // An edit (or out-of-band change) reshapes the dependency graph — drop stale
    // maps and the provider's cached import graph.
    if (event.type === "tool_call" || event.type === "out_of_band_change") {
      this.impactCache.clear();
      void this.impactProviderPromise?.then((p) => p.invalidate?.());
    }
    if (this.narrator !== null) this.narrate(this.narrator, event);
  }

  /**
   * Build (or rebuild, on resume) the live agent runner with shared wiring.
   * `firstMessage` is the opening turn; `resumeId` re-attaches to a saved SDK
   * session so the agent continues with full prior context.
   */
  private startRunner(firstMessage: string, resumeId?: string, planMode = false): RunningSession {
    const provider = this.session.agentSdk;
    const model = this.session.agentModel ?? undefined;
    // Merge the test-injected `query` and the per-session model into the
    // server's base credentials, then resolve the right adapter for the provider.
    const adapterConfig: AdapterConfig = {
      claude: { ...this.adapterConfig.claude, queryImpl: this.queryImpl },
      gemini: { ...this.adapterConfig.gemini, ...(model ? { model } : {}) },
      codex: { ...this.adapterConfig.codex, ...(model ? { model } : {}) },
    };
    const running = runJigSession({
      session: this.session,
      prompt: firstMessage,
      pacer: this.pacer,
      store: this.store,
      worktree: new Worktree(this.repoPath),
      onEvent: (event) => this.handleEvent(event),
      sdk: getSDKAdapter(provider, adapterConfig),
      // Claude takes its model via SDK options; gemini/codex via adapter deps above.
      options: provider === "claude" && model ? { model } : undefined,
      askQuestion: (input) => this.askHuman(input),
      reviewPlan: (input) => this.reviewPlan(input),
      resume: resumeId,
      planMode,
      onSessionId: (cid) => this.store.setClaudeSessionId(this.id, cid),
    });
    this.live = true;
    this.stopRequested = false;
    // When the turn (or the whole run) unwinds, settle status and tell clients.
    void running.result.catch(() => {}).finally(() => this.onRunnerFinished());
    return running;
  }

  /** The live run ended. session.ts already set done/error; a stop is a pause. */
  private onRunnerFinished(): void {
    this.live = false;
    if (this.stopRequested) {
      this.store.setSessionStatus(this.id, "paused");
      this.stopRequested = false;
    }
    this.broadcaster.broadcast({ type: "session_state", session: this.meta() });
    this.onAttention?.();
    // Auto-review (if enabled) is client-driven on the `done` transition, so it
    // uses the developer's configured default reviewer (a client setting).
  }

  /** Cleanly halt the agent; the session becomes `paused` and stays resumable. */
  stop(): void {
    if (!this.live) return;
    this.stopRequested = true;
    this.clearPendingHumanGates("Stopped by the developer.");
    // Drop any gated edits so a parked canUseTool unblocks and the run can unwind.
    for (const p of [...this.pacer.queue]) this.pacer.reject(p.editId, "Stopped by the developer.");
    void this.running.interrupt().catch(() => {});
  }

  /**
   * Re-attach to the saved Claude session and continue with `firstMessage`. This
   * is how a stopped/finished/detached session resumes: sending a new directive
   * spins a fresh `query({ resume })` so the agent picks up with full context.
   */
  private resume(firstMessage: string): void {
    if (this.live) return;
    const claudeId = this.store.getClaudeSessionId(this.id) ?? undefined;
    this.store.setSessionStatus(this.id, "running");
    this.running = this.startRunner(firstMessage, claudeId);
    this.broadcaster.broadcast({ type: "session_state", session: this.meta() });
    this.onAttention?.();
  }

  /** Resolve & clear any open question/plan the agent is parked on. */
  private clearPendingHumanGates(reason: string): void {
    if (this.answerQuestion) {
      this.answerQuestion(reason);
      this.answerQuestion = null;
    }
    if (this.question !== null) {
      this.question = null;
      this.broadcaster.broadcast({ type: "question_state", question: null });
    }
    if (this.decidePlan) {
      this.decidePlan({ approved: false, message: reason });
      this.decidePlan = null;
    }
    if (this.plan !== null) {
      this.plan = null;
      this.broadcaster.broadcast({ type: "plan_state", plan: null });
    }
  }

  /** The dial mode from the last dial_change event, if any. */
  private restoreMode(): DialMode | null {
    const events = this.store.listEvents(this.id);
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === "dial_change") {
        const mode = ((events[i]?.payload ?? {}) as { mode?: DialMode }).mode;
        if (mode) return mode;
      }
    }
    return null;
  }

  /**
   * Give the session a short title for the tab/header. Set a heuristic one at
   * once (so nothing ever shows a raw prompt), then upgrade to an LLM title when
   * a narrator is configured, broadcasting the refreshed session state.
   */
  private initTitle(prompt: string): void {
    this.store.setSessionTitle(this.id, heuristicTitle(prompt));
    const narrator = this.narrator;
    if (narrator === null) return;
    void narrator.title(prompt).then((title) => {
      // A manual rename wins over the (later-arriving) generated title.
      if (title && !this.titleManual) {
        this.store.setSessionTitle(this.id, title);
        this.broadcaster.broadcast({ type: "session_state", session: this.meta() });
      }
    });
  }

  /** Human rename — sticks, and blocks any pending generated title. */
  setTitle(title: string): void {
    this.titleManual = true;
    this.store.setSessionTitle(this.id, title);
    this.broadcaster.broadcast({ type: "session_state", session: this.meta() });
  }

  meta(): Session {
    return this.store.getSession(this.id) ?? this.fallbackMeta();
  }

  /**
   * Read a slice of a file in this session's worktree, for the Review tab to
   * expand context around an edit (or preview a touched file). `from`/`to` are
   * 1-indexed and inclusive; omitting them returns the whole file. Throws if the
   * path escapes the worktree (traversal) or the file can't be read.
   */
  readFileSlice(relPath: string, from?: number, to?: number): FileSlice {
    const target = isAbsolute(relPath) ? resolve(relPath) : resolve(this.repoPath, relPath);
    // Cheap lexical containment: rejects `../` traversal and absolute paths.
    const lexRel = relative(this.repoPath, target);
    if (lexRel === "" || lexRel.startsWith("..") || isAbsolute(lexRel)) {
      throw new Error("path escapes the session worktree");
    }
    // Symlink containment: a lexical check alone lets a symlink *inside* the
    // worktree point outside it, so resolve real paths too. realpathSync throws
    // ENOENT for a missing file, which we surface as a plain read error.
    let realBase: string;
    let realTarget: string;
    try {
      realBase = realpathSync(this.repoPath);
      realTarget = realpathSync(target);
    } catch {
      throw new Error("file not found in the session worktree");
    }
    const rel = relative(realBase, realTarget);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error("path escapes the session worktree");
    }
    const all = readFileSync(realTarget, "utf8").split("\n");
    const total = all.length;
    const start = from && from > 0 ? from : 1;
    const end = to && to > 0 ? Math.min(to, total) : total;
    const lines = end >= start ? all.slice(start - 1, end) : [];
    return { path: relPath, totalLines: total, from: start, to: Math.max(start - 1, end), lines };
  }

  /** Meta + the "needs the human" state used to badge the tab. */
  summary(): SessionSummary {
    return {
      ...this.meta(),
      pendingEdits: this.pacer.queue.length,
      awaitingQuestion: this.question !== null,
      awaitingPlan: this.plan !== null,
      resumable: this.store.getClaudeSessionId(this.id) !== null,
    };
  }

  /** Snapshot current state to a freshly-connected client, then keep it updated. */
  addClient(ws: WebSocket): void {
    this.broadcaster.send(ws, { type: "session_state", session: this.meta() });
    this.broadcaster.send(ws, { type: "dial_state", mode: this.pacer.mode });
    this.broadcaster.send(ws, { type: "queue_state", pending: this.pacer.queue });
    for (const event of this.store.listEvents(this.id)) {
      this.broadcaster.send(ws, { type: "event", event });
    }
    this.broadcaster.send(ws, { type: "change_view", view: this.changeView() });
    this.broadcaster.send(ws, { type: "question_state", question: this.question });
    this.broadcaster.send(ws, { type: "plan_state", plan: this.plan });
    this.broadcaster.add(ws);
    this.onAttention?.(); // give the new client the current cross-session summary
  }

  /** Push the cross-session tab summary to this session's connected clients. */
  pushSummary(sessions: SessionSummary[]): void {
    this.broadcaster.broadcast({ type: "sessions_summary", sessions });
  }

  handle(msg: ClientToServer): void {
    if (msg.type === "set_dial") this.pacer.setMode(msg.mode);
    else if (msg.type === "ack_edit") this.pacer.ack(msg.editId);
    else if (msg.type === "reject_edit") this.rejectEdit(msg.editId, msg.reason);
    else if (msg.type === "send_directive")
      this.sendDirective(msg.text, msg.anchorEditId, msg.lineComments);
    else if (msg.type === "stop_session") this.stop();
    else if (msg.type === "sidecar_message") this.askSidecar(msg.text, msg.provider, msg.model);
    else if (msg.type === "request_files") this.broadcastFiles();
    else if (msg.type === "request_skills") this.broadcastSkills();
    else if (msg.type === "save_skill") this.handleSaveSkill(msg.scope, msg.name, msg.body);
    else if (msg.type === "draft_skill") void this.draftSkill(msg.prompt, msg.provider, msg.model);
    else if (msg.type === "answer_question") this.resolveQuestion(msg.questionId, msg.answers);
    else if (msg.type === "decide_plan") this.resolvePlan(msg.planId, msg.approved, msg.reason);
    else if (msg.type === "request_impact") void this.requestImpact(msg.path);
    else if (msg.type === "request_lsp_servers") this.broadcastLspServers();
    else if (msg.type === "install_lsp") void this.installLsp(msg.serverId, msg.path);
    else if (msg.type === "request_review_diff") this.broadcastReviewDiff();
    else if (msg.type === "request_review")
      void this.runReview(msg.provider, msg.model, msg.instructions);
    else if (msg.type === "add_review_comment") this.addReviewComment(msg);
    else if (msg.type === "resolve_review_comment") this.setReviewResolved(msg.id, msg.resolved);
    else if (msg.type === "delete_review_comment") this.deleteReviewComment(msg.id);
    else if (msg.type === "submit_review") this.submitReview(msg.text);
    else if (msg.type === "set_auto_review") this.setAutoReview(msg.enabled);
  }

  // --- Code review (PR-format, post-completion) ---

  /** The net change since the session's base commit, as per-file structured diffs. */
  private reviewDiff() {
    const base = this.session.baseRef ?? "HEAD";
    return new Worktree(this.repoPath).diff(base);
  }

  private broadcastReviewDiff(): void {
    this.broadcaster.broadcast({
      type: "review_diff",
      base: this.session.baseRef ?? "HEAD",
      files: this.reviewDiff(),
    });
  }

  /** Reduce the review_comment event log by comment id → latest, dropping tombstones. */
  private reviewComments(): ReviewComment[] {
    const byId = new Map<string, ReviewComment>();
    for (const e of this.store.listEvents(this.id)) {
      if (e.type === "review_comment") {
        const c = e.payload as ReviewComment;
        byId.set(c.id, c);
      }
    }
    return [...byId.values()].filter((c) => !c.deleted);
  }

  /** Persist a review comment (add/update/tombstone) and broadcast the event. */
  private putReviewComment(comment: ReviewComment): void {
    const event = this.store.appendEvent({
      sessionId: this.id,
      type: "review_comment",
      payload: comment,
    });
    this.broadcaster.broadcast({ type: "event", event });
  }

  private addReviewComment(msg: {
    path: string;
    side: "old" | "new";
    line: number;
    lineText: string;
    body: string;
  }): void {
    this.putReviewComment({
      id: randomUUID(),
      author: "human",
      model: null,
      path: msg.path,
      side: msg.side,
      line: msg.line,
      lineText: msg.lineText,
      body: msg.body,
      severity: "info",
      resolved: false,
      deleted: false,
      createdAt: Date.now(),
    });
  }

  private setReviewResolved(id: string, resolved: boolean): void {
    const c = this.reviewComments().find((x) => x.id === id);
    if (c) this.putReviewComment({ ...c, resolved });
  }

  private deleteReviewComment(id: string): void {
    const c = this.reviewComments().find((x) => x.id === id);
    if (c) this.putReviewComment({ ...c, deleted: true });
  }

  /** Send all unresolved review comments back to the coding agent as fixes. */
  private submitReview(text: string): void {
    const open = this.reviewComments().filter((c) => !c.resolved);
    if (open.length === 0 && !text.trim()) return;
    const directive = composeReviewFeedback(open, text);
    if (this.live) this.running.sendDirective(directive);
    else this.resume(directive);
    // Mark the submitted comments resolved so a re-review starts clean.
    for (const c of open) this.putReviewComment({ ...c, resolved: true });
    const ev = this.store.appendEvent({
      sessionId: this.id,
      type: "directive",
      payload: { text: directive, source: "review" },
    });
    this.broadcaster.broadcast({ type: "event", event: ev });
  }

  private setAutoReview(enabled: boolean): void {
    this.store.setAutoReview(this.id, enabled);
    this.session = { ...this.session, autoReview: enabled };
    this.broadcaster.broadcast({ type: "session_state", session: this.meta() });
  }

  /** The per-session adapter config (test query + per-provider creds + model). */
  private adapterConfigFor(model?: string): AdapterConfig {
    return {
      claude: { ...this.adapterConfig.claude, queryImpl: this.queryImpl },
      gemini: { ...this.adapterConfig.gemini, ...(model ? { model } : {}) },
      codex: { ...this.adapterConfig.codex, ...(model ? { model } : {}) },
    };
  }

  /** Run the selected/default reviewer over the PR diff; persist its inline comments. */
  private async runReview(
    provider: AgentProvider | null,
    model: string | null,
    instructions: string | null = null,
  ): Promise<void> {
    const p = provider ?? this.session.agentSdk;
    const m = model ?? this.session.agentModel ?? undefined;
    const status = (s: "running" | "done" | "error", error: string | null = null) =>
      this.broadcaster.broadcast({
        type: "review_status",
        status: s,
        provider: p,
        model: m ?? null,
        error,
      });
    status("running");
    try {
      const files = this.reviewDiff();
      if (files.length === 0) return status("done");
      const transcript = buildTranscript(this.store.listEvents(this.id));
      const prompt = buildReviewPrompt(files, this.session.taskPrompt, transcript);
      const adapter = getSDKAdapter(p, this.adapterConfigFor(m));
      const out = await runReadOnly(adapter, {
        prompt,
        cwd: this.repoPath,
        appendSystemPrompt: reviewerSystem(instructions),
      });
      // Look up each commented line's text from the diff (for the fix directive).
      const lineText = new Map<string, string>();
      for (const f of files) {
        for (const h of f.hunks) {
          for (const r of h.rows) {
            const ln = r.newLine;
            if (ln !== null) lineText.set(`${f.path}:new:${ln}`, r.text);
            if (r.oldLine !== null) lineText.set(`${f.path}:old:${r.oldLine}`, r.text);
          }
        }
      }
      for (const c of parseReviewComments(out)) {
        this.putReviewComment({
          id: randomUUID(),
          author: p,
          model: m ?? null,
          path: c.path,
          side: c.side,
          line: c.line,
          lineText: lineText.get(`${c.path}:${c.side}:${c.line}`) ?? "",
          body: c.body,
          severity: c.severity,
          resolved: false,
          deleted: false,
          createdAt: Date.now(),
        });
      }
      status("done");
    } catch (e) {
      status("error", (e as Error).message ?? "review failed");
    }
  }

  /** The language-server registry with this session's install state, for Settings. */
  private broadcastLspServers(installingId?: string): void {
    const servers = listServerStatus(this.repoPath).map((s) => ({
      ...s,
      installing: s.serverId === installingId,
    }));
    this.broadcaster.broadcast({ type: "lsp_servers", servers });
  }

  private impactProvider(): Promise<CodeGraphProvider> {
    this.impactProviderPromise ??=
      this.injectedProvider !== undefined
        ? Promise.resolve(this.injectedProvider)
        : LspCodeGraphProvider.create(this.repoPath);
    return this.impactProviderPromise;
  }

  /**
   * Compute (off the hot path) and broadcast the 1-hop dependency impact map for a
   * focused file. The edited lines come from this file's tool_call payloads
   * (`startLine`/`startLines`, computed at the gate) and anchor the ripple subset.
   * Cached per path; the cache is cleared whenever an edit reshapes the graph.
   */
  /** Broadcast an impact map echoing the requested path, so the client can match it. */
  private sendImpact(requested: string, map: ImpactMap | null): void {
    this.broadcaster.broadcast({ type: "impact_map", requested, map });
  }

  private async requestImpact(path: string): Promise<void> {
    const cached = this.impactCache.get(path);
    if (cached) {
      this.sendImpact(path, cached);
      return;
    }
    let focus: string;
    try {
      focus = this.resolveInWorktree(path);
    } catch {
      this.sendImpact(path, null);
      return;
    }

    const { editedSymbols, edits } = this.editedSymbolsFor(path);
    try {
      const provider = await this.impactProvider();
      const map = await buildImpactMap({
        focus,
        repoRoot: this.repoPath,
        editedSymbols,
        edits,
        provider,
      });
      this.impactCache.set(path, map);
      this.sendImpact(path, map);
    } catch {
      this.sendImpact(path, null);
    }
  }

  /**
   * Install a language server on demand (from the degraded map or from Settings),
   * then refresh the server list and, if a file was focused, its impact map. The
   * whole impact cache is cleared because a new server lifts the degraded state for
   * every file of that language, not just the focused one.
   */
  private async installLsp(serverId: string, path: string | null): Promise<void> {
    const desc = descriptorById(serverId);
    if (!desc) return;
    this.broadcastLspServers(serverId); // optimistic "installing…" in Settings
    if (path) {
      const cached = this.impactCache.get(path);
      if (cached?.install) {
        this.sendImpact(path, { ...cached, install: { ...cached.install, installing: true } });
      }
    }
    await installServer(desc).catch(() => null);
    this.impactCache.clear(); // capabilities changed — recompute on next focus
    this.broadcastLspServers();
    if (path) await this.requestImpact(path);
  }

  /** Edited lines (0-based) and edit count for a path, from its tool_call events. */
  private editedSymbolsFor(path: string): { editedSymbols: SymbolRef[]; edits: number } {
    const editedSymbols: SymbolRef[] = [];
    let edits = 0;
    for (const e of this.store.listEvents(this.id)) {
      if (e.type !== "tool_call" || e.editId === null) continue;
      const p = (e.payload ?? {}) as {
        file_path?: string;
        startLine?: number;
        startLines?: number[];
      };
      if (p.file_path !== path) continue;
      edits++;
      if (typeof p.startLine === "number")
        editedSymbols.push({ name: "", line: p.startLine - 1, character: 0 });
      for (const sl of p.startLines ?? [])
        editedSymbols.push({ name: "", line: sl - 1, character: 0 });
    }
    return { editedSymbols, edits };
  }

  /** Resolve a (possibly absolute) focus path and assert it stays inside the worktree. */
  private resolveInWorktree(path: string): string {
    const target = isAbsolute(path) ? resolve(path) : resolve(this.repoPath, path);
    const real = realpathSync(target);
    const rel = relative(realpathSync(this.repoPath), real);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error("path escapes the session worktree");
    }
    return real;
  }

  /**
   * The agent called AskUserQuestion. Surface it to the human and block until they
   * answer; resolve with the formatted answer, which the gate hands back to the
   * agent as the deny message (its only channel for returning a tool result).
   */
  private askHuman(input: Record<string, unknown>): Promise<string> {
    const questions = parseQuestions(input);
    const pending: PendingQuestion = { id: randomUUID(), questions };
    this.question = pending;
    this.broadcaster.broadcast({ type: "question_state", question: pending });
    this.onAttention?.();
    return new Promise<string>((resolve) => {
      this.answerQuestion = resolve;
    });
  }

  /**
   * The agent called ExitPlanMode. Surface the plan and block until the human
   * decides: approve (the gate allows the tool and we flip the agent out of plan
   * mode into `default`, so execution is still paced by the dial) or request
   * changes (the gate denies with the feedback, so the agent keeps planning).
   */
  private reviewPlan(
    input: Record<string, unknown>,
  ): Promise<{ approved: boolean; message?: string }> {
    const plan = typeof input.plan === "string" ? input.plan : "";
    const pending: PendingPlan = { id: randomUUID(), plan };
    this.plan = pending;
    this.broadcaster.broadcast({ type: "plan_state", plan: pending });
    this.onAttention?.();
    return new Promise((resolve) => {
      this.decidePlan = resolve;
    });
  }

  private resolvePlan(planId: string, approved: boolean, reason: string): void {
    if (this.plan === null || this.plan.id !== planId) return;
    const resolve = this.decidePlan;
    const note = approved
      ? "Plan approved — executing."
      : `Plan changes requested: ${reason || "(no detail)"}`;
    const event = this.store.appendEvent({
      sessionId: this.id,
      type: "directive",
      payload: { text: note },
    });
    this.broadcaster.broadcast({ type: "event", event });
    this.plan = null;
    this.decidePlan = null;
    this.broadcaster.broadcast({ type: "plan_state", plan: null });
    this.onAttention?.();
    // On approval, leave plan mode so the agent can act; keep it paced via the gate.
    const finish = () => resolve?.({ approved, message: reason });
    if (approved) void this.running.setPermissionMode("default").then(finish, finish);
    else finish();
  }

  private resolveQuestion(questionId: string, answers: Record<string, string>): void {
    if (this.question === null || this.question.id !== questionId) return;
    const resolve = this.answerQuestion;
    const message = formatAnswers(this.question, answers);
    // Log the human's answer so it shows in history and feeds the sidecar.
    const event = this.store.appendEvent({
      sessionId: this.id,
      type: "directive",
      payload: { text: message },
    });
    this.broadcaster.broadcast({ type: "event", event });
    this.question = null;
    this.answerQuestion = null;
    this.broadcaster.broadcast({ type: "question_state", question: null });
    this.onAttention?.();
    resolve?.(message);
  }

  async close(): Promise<void> {
    // Unblock a pending question/plan so the agent's canUseTool await doesn't hang.
    this.clearPendingHumanGates("The developer ended the session.");
    await this.running.interrupt().catch(() => {});
    await this.sidecar.close().catch(() => {});
    // Shut down any language servers this session spawned for the impact map.
    await this.impactProviderPromise
      ?.then((p) => (p as Partial<LspCodeGraphProvider>).dispose?.())
      .catch(() => {});
  }

  private changeView(): ChangeView {
    const events = this.store.listEvents(this.id);
    const view = buildChangeView(events, this.analyzer);
    this.enrichIntentLabels(view, events);
    return view;
  }
  private broadcastChangeView(): void {
    this.broadcaster.broadcast({ type: "change_view", view: this.changeView() });
  }

  /**
   * Replace each group's heuristic label with a crisp LLM-generated intent
   * summary when available; trigger generation (once per group) for long
   * reasonings otherwise, re-broadcasting when each resolves. Cached by group id.
   */
  private enrichIntentLabels(view: ChangeView, events: JigEvent[]): void {
    const narrator = this.narrator;
    if (narrator === null) return;
    const reasonById = new Map(groupByIntent(visibleEvents(events)).map((g) => [g.id, g.reason]));
    for (const group of view) {
      const cached = this.intentLabels.get(group.id);
      if (cached) {
        group.label = cached;
        continue;
      }
      const reason = reasonById.get(group.id) ?? "";
      // A short reasoning already makes a fine label; don't spend a call on it.
      if (reason.trim().length < 24 || this.intentPending.has(group.id)) continue;
      this.intentPending.add(group.id);
      void narrator.summarize(reason).then((label) => {
        this.intentPending.delete(group.id);
        if (label) {
          this.intentLabels.set(group.id, label);
          this.broadcastChangeView();
        }
      });
    }
  }

  /** Discard a pending edit, handing the agent a reason to revise. */
  private rejectEdit(editId: string, reason: string): void {
    this.pacer.reject(editId, reason);
  }

  /**
   * Steering reroutes the agent. While an edit is pending the agent is parked
   * inside `canUseTool` awaiting the gate, so a directive injected into the input
   * stream can't reach it — steering must *reject* the pending edit(s), handing
   * the guidance back as the deny reason so the agent unblocks and reroutes. We
   * reject the named edit if one was anchored, else every pending edit (in slowed
   * mode that is the single edit the agent is blocked on). With nothing pending,
   * the agent is mid-thought: inject the directive for the next tool-call boundary.
   */
  private sendDirective(
    text: string,
    anchorEditId: string | null,
    lineComments: LineComment[] = [],
  ): void {
    // Line comments (Phase 1 @mentions): turn the marked-up diff into feedback
    // per edit. Each commented edit that's still pending is rejected with its own
    // aggregated comments (+ the shared message), so the agent revises precisely;
    // un-commented edits stay queued. With nothing commented pending, ship the
    // whole annotated batch as one directive (inject if live, else resume).
    if (lineComments.length > 0) {
      const groups = groupCommentsByEdit(lineComments);
      const pendingGroups = groups.filter((g) => this.pacer.isPending(g.editId));
      const composedFull = composeAllComments(lineComments, text);

      if (pendingGroups.length > 0) {
        for (const g of pendingGroups) this.pacer.reject(g.editId, composeEditFeedback(g, text));
      } else if (this.live) {
        this.running.sendDirective(composedFull);
      } else {
        this.resume(composedFull);
      }

      const event = this.store.appendEvent({
        sessionId: this.id,
        type: "directive",
        editId: anchorEditId,
        payload: { text: composedFull, lineComments },
      });
      this.broadcaster.broadcast({ type: "event", event });
      return;
    }

    let composed = text;
    if (anchorEditId !== null) {
      const call = this.store
        .listEvents(this.id)
        .find((e) => e.type === "tool_call" && e.editId === anchorEditId);
      const path = ((call?.payload ?? {}) as { file_path?: string }).file_path;
      if (path) composed = `Re: your edit to ${path} — ${text}`;
    }

    const targets =
      anchorEditId !== null && this.pacer.isPending(anchorEditId)
        ? [anchorEditId]
        : this.pacer.queue.map((p) => p.editId);

    if (targets.length > 0) {
      for (const id of targets) this.pacer.reject(id, composed);
    } else if (this.live) {
      this.running.sendDirective(composed);
    } else {
      // The agent has finished or been stopped — a new instruction resumes it.
      this.resume(composed);
    }

    const event = this.store.appendEvent({
      sessionId: this.id,
      type: "directive",
      editId: anchorEditId,
      payload: { text: composed },
    });
    this.broadcaster.broadcast({ type: "event", event });
  }

  private askSidecar(
    text: string,
    provider: AgentProvider | null = null,
    model: string | null = null,
  ): void {
    const events = this.store.listEvents(this.id);
    const transcript = buildTranscript(events);
    const pending = this.pacer.queue
      .map((p) => {
        const call = events.find((e) => e.type === "tool_call" && e.editId === p.editId);
        const pl = (call?.payload ?? {}) as { new_string?: string; content?: string };
        const after = (pl.new_string ?? pl.content ?? "").slice(0, 800);
        return `PENDING (awaiting the developer's ack — NOT yet on disk) ${p.path}:\n${after}`;
      })
      .join("\n\n");
    const prompt = [
      `Transcript of the agent so far:\n${transcript || "(nothing yet)"}`,
      pending ? `\nEdits in the buffer (not yet applied):\n${pending}` : "",
      `\nDeveloper's question: ${text}`,
    ].join("\n");
    const reply = (text: string) => this.broadcaster.broadcast({ type: "sidecar_reply", text });
    // A picked provider/model gets a one-shot read-only "second opinion"; the
    // default keeps using the persistent (fast, stateful) Claude sidecar.
    if (provider !== null || model !== null) {
      const adapter = getSDKAdapter(
        provider ?? this.session.agentSdk,
        this.adapterConfigFor(model ?? undefined),
      );
      void runReadOnly(adapter, { prompt, cwd: this.repoPath, appendSystemPrompt: SIDECAR_SYSTEM })
        .then(reply)
        .catch((e) => reply(`(second opinion failed: ${(e as Error).message})`));
    } else {
      void this.sidecar.ask(prompt).then(reply);
    }
  }

  /** Repo-relative tracked files, for @file mention autocomplete (capped). */
  private broadcastFiles(): void {
    let files: string[] = [];
    try {
      const out = execFileSync("git", ["-C", this.repoPath, "ls-files", "-z"], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
      files = out
        .split("\0")
        .filter((f) => f.length > 0)
        .slice(0, 5000);
    } catch {
      files = [];
    }
    this.broadcaster.broadcast({ type: "files_list", files });
  }

  // --- Skills ---

  private broadcastSkills(): void {
    this.broadcaster.broadcast({ type: "skills_list", skills: listSkills(this.repoPath) });
  }

  private handleSaveSkill(scope: "repo" | "user", name: string, body: string): void {
    try {
      saveSkill(this.repoPath, scope, name, body);
    } catch {
      // ignore write failures; the list simply won't gain the skill
    }
    this.broadcastSkills();
  }

  /** Generate a SKILL.md draft from a prompt via the chosen/default model. */
  private async draftSkill(
    prompt: string,
    provider: AgentProvider | null,
    model: string | null,
  ): Promise<void> {
    try {
      const adapter = getSDKAdapter(
        provider ?? this.session.agentSdk,
        this.adapterConfigFor(model ?? undefined),
      );
      const body = await runReadOnly(adapter, {
        prompt: `Write a SKILL.md for: ${prompt}`,
        cwd: this.repoPath,
        appendSystemPrompt: SKILL_AUTHOR_SYSTEM,
      });
      this.broadcaster.broadcast({ type: "skill_draft", body, error: null });
    } catch (e) {
      this.broadcaster.broadcast({ type: "skill_draft", body: "", error: (e as Error).message });
    }
  }

  private narrate(narrator: Narrator, event: JigEvent): void {
    if (event.type !== "tool_call" || event.editId === null) return;
    if (!isWriteClass(event.toolName ?? "")) return;
    const editId = event.editId;
    const p = (event.payload ?? {}) as {
      file_path?: string;
      old_string?: string;
      new_string?: string;
      content?: string;
    };
    void (async () => {
      const prior = this.store.listEvents(this.id);
      const reasoning = [...prior]
        .reverse()
        .find((e) => e.type === "reasoning" && e.seq < event.seq);
      const text = await narrator.narrate({
        toolName: event.toolName ?? "",
        path: p.file_path ?? "",
        before: p.old_string ?? "",
        after: p.new_string ?? p.content ?? "",
        reasoning: ((reasoning?.payload ?? {}) as { text?: string }).text ?? "",
      });
      if (text !== null) {
        const ev = this.store.appendEvent({
          sessionId: this.id,
          type: "narration",
          editId,
          payload: { text },
        });
        this.broadcaster.broadcast({ type: "event", event: ev });
      }
    })();
  }

  private fallbackMeta(): Session {
    return {
      id: this.id,
      repoPath: this.repoPath,
      taskPrompt: "",
      title: null,
      status: "running",
      agentSdk: this.session.agentSdk,
      agentModel: this.session.agentModel,
      baseRef: this.session.baseRef,
      autoReview: this.session.autoReview,
      startedAt: 0,
      endedAt: null,
    };
  }
}

/** First line of the prompt, capped — a stand-in title until the LLM titles it. */
function heuristicTitle(prompt: string): string {
  const firstLine = prompt.trim().split("\n")[0]?.trim() ?? "";
  const base = firstLine || prompt.trim();
  if (base.length === 0) return "Untitled session";
  return base.length <= 56 ? base : `${base.slice(0, 55).trimEnd()}…`;
}

/** Defensively turn the agent's AskUserQuestion input into our Question shape. */
function parseQuestions(input: Record<string, unknown>): Question[] {
  const raw = Array.isArray(input.questions) ? (input.questions as unknown[]) : [];
  return raw.map((q) => {
    const o = (q ?? {}) as {
      question?: string;
      header?: string;
      multiSelect?: boolean;
      options?: { label?: string; description?: string; preview?: string }[];
    };
    return {
      header: o.header ?? "",
      question: o.question ?? "",
      multiSelect: Boolean(o.multiSelect),
      options: (o.options ?? []).map((opt) => ({
        label: opt.label ?? "",
        description: opt.description ?? "",
        preview: opt.preview,
      })),
    };
  });
}

/** The message handed back to the agent as the answer to its question. */
function formatAnswers(pending: PendingQuestion, answers: Record<string, string>): string {
  const lines = pending.questions.map((q) => {
    const a = answers[q.question]?.trim();
    return `- ${q.header || q.question}: ${a && a.length > 0 ? a : "(no answer)"}`;
  });
  const plural = pending.questions.length > 1 ? "s" : "";
  return `The developer answered your question${plural}:\n${lines.join("\n")}`;
}
