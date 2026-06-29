import type {
  AgentProvider,
  ChangeView,
  ClientToServer,
  DialMode,
  ImpactMap,
  JigEvent,
  LineComment,
  LspServerInfo,
  PendingEdit,
  PendingPlan,
  PendingQuestion,
  ReviewComment,
  ReviewFileDiff,
  ReviewStatus,
  ServerToClient,
  Session,
  SessionSummary,
  Skill,
} from "@agent-jig/contracts";

/** Live view over the server's websocket stream, exposed as Svelte 5 runes. */
export class JigConnection {
  session = $state<Session | null>(null);
  mode = $state<DialMode>("slowed");
  queue = $state<PendingEdit[]>([]);
  events = $state<JigEvent[]>([]);
  changeView = $state<ChangeView>([]);
  /** The agent's open question, if it's waiting on the human. */
  question = $state<PendingQuestion | null>(null);
  /** The agent's plan awaiting approval, if any. */
  plan = $state<PendingPlan | null>(null);
  /** Live cross-session tab summary (attention badges), pushed by the server. */
  summary = $state<SessionSummary[] | null>(null);
  /** The dependency impact map for the focused file; null while computing/unavailable. */
  impactMap = $state<ImpactMap | null>(null);
  /** The path we last requested an impact map for, so a stale map can be ignored. */
  impactFocus = $state<string | null>(null);
  /** True between requesting an impact map and its arrival, to drive a spinner. */
  impactLoading = $state(false);
  /** The language-server registry with install state, for the Settings panel. */
  lspServers = $state<LspServerInfo[]>([]);
  /** One unified human↔system conversation: questions, sidecar replies, and steers. */
  conversation = $state<Array<{ role: "you" | "sidecar" | "steer"; text: string }>>([]);
  /**
   * Line comments the human has anchored to edits but not yet sent. They
   * accumulate across edits and ship together on the next steer (Phase 1
   * @mentions). Edit-anchored — kept separate from the free-text input.
   */
  lineComments = $state<LineComment[]>([]);
  connected = $state(false);
  /** A human-readable error to surface as a toast; cleared by the UI. */
  lastError = $state<string | null>(null);
  /** PR-format net diff (first edit → last) for the review panel. */
  reviewDiff = $state<ReviewFileDiff[]>([]);
  /** The base commit the review diff is against. */
  reviewBase = $state<string>("");
  /** Repo file paths for @file mention autocomplete. */
  files = $state<string[]>([]);
  /** Discovered skills (repo + user) for the browser and /skill autocomplete. */
  skills = $state<Skill[]>([]);
  /** The latest model-generated SKILL.md draft (and any error), for the creator. */
  skillDraft = $state<{ body: string; error: string | null } | null>(null);
  /** The reviewer agent's run state. */
  reviewStatus = $state<{
    status: ReviewStatus;
    provider: AgentProvider | null;
    model: string | null;
    error: string | null;
  }>({ status: "idle", provider: null, model: null, error: null });

  /** Review comments (human + AI), reduced from the event log by comment id. */
  get reviewComments(): ReviewComment[] {
    const byId = new Map<string, ReviewComment>();
    for (const e of this.events) {
      if (e.type === "review_comment") {
        const c = e.payload as ReviewComment;
        byId.set(c.id, c);
      }
    }
    return [...byId.values()].filter((c) => !c.deleted);
  }

  #ws: WebSocket | null = null;
  /** The current stream URL, so a dropped socket can reconnect to it. */
  #url: string | null = null;
  /** Backoff counter for reconnects; reset on a clean open. */
  #retries = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** (Re)connect to a session's stream, resetting state so tabs switch cleanly. */
  connect(url: string): void {
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#ws?.close();
    this.#url = url;
    this.#retries = 0;
    this.session = null;
    this.mode = "slowed";
    this.queue = [];
    this.events = [];
    this.changeView = [];
    this.question = null;
    this.plan = null;
    this.summary = null;
    this.impactMap = null;
    this.impactFocus = null;
    this.impactLoading = false;
    this.lspServers = [];
    this.conversation = [];
    this.lineComments = [];
    this.reviewDiff = [];
    this.reviewBase = "";
    this.files = [];
    this.skills = [];
    this.skillDraft = null;
    this.reviewStatus = { status: "idle", provider: null, model: null, error: null };
    this.connected = false;
    this.lastError = null;
    this.#open(url);
  }

  /**
   * Open a socket to `url`. A drop (`onclose`) auto-reconnects with backoff —
   * *without* resetting state, so a network blip doesn't blank the screen; the
   * server replays a full snapshot on reconnect and events upsert by id. A stale
   * socket (superseded by a tab switch) is ignored via identity guard.
   */
  #open(url: string): void {
    const ws = new WebSocket(url);
    this.#ws = ws;
    ws.onopen = () => {
      if (this.#ws !== ws) return;
      this.connected = true;
      this.#retries = 0;
    };
    ws.onclose = () => {
      if (this.#ws !== ws) return; // superseded by a deliberate reconnect
      this.connected = false;
      this.#scheduleReconnect();
    };
    ws.onerror = () => {
      if (this.#ws !== ws) return;
      this.lastError = "Lost connection to the server — reconnecting…";
    };
    ws.onmessage = (e) => {
      try {
        this.#handle(JSON.parse(e.data as string) as ServerToClient);
      } catch {
        this.lastError = "Received a malformed message from the server.";
      }
    };
  }

  #scheduleReconnect(): void {
    if (this.#url === null || this.#reconnectTimer !== null) return;
    const delay = Math.min(500 * 2 ** this.#retries, 10_000);
    this.#retries++;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.#url !== null) this.#open(this.#url);
    }, delay);
  }

  #handle(msg: ServerToClient): void {
    switch (msg.type) {
      case "session_state":
        this.session = msg.session;
        break;
      case "dial_state":
        this.mode = msg.mode;
        break;
      case "queue_state":
        this.queue = msg.pending;
        break;
      case "event": {
        // Upsert by id: a re-emitted event (e.g. a resolved question's tool_call)
        // replaces the earlier one rather than duplicating.
        const i = this.events.findIndex((e) => e.id === msg.event.id);
        if (i === -1) {
          this.events = [...this.events, msg.event];
        } else {
          const next = [...this.events];
          next[i] = msg.event;
          this.events = next;
        }
        break;
      }
      case "change_view":
        this.changeView = msg.view;
        break;
      case "sidecar_reply":
        this.conversation = [...this.conversation, { role: "sidecar", text: msg.text }];
        break;
      case "question_state":
        this.question = msg.question;
        break;
      case "plan_state":
        this.plan = msg.plan;
        break;
      case "sessions_summary":
        this.summary = msg.sessions;
        break;
      case "impact_map":
        // Match on the echoed request path (the map's own focus is repo-relative
        // and won't equal an absolute request). Drops late maps for a stale focus.
        if (msg.requested === this.impactFocus) {
          this.impactMap = msg.map;
          this.impactLoading = false;
        }
        break;
      case "lsp_servers":
        this.lspServers = msg.servers;
        break;
      case "review_diff":
        this.reviewDiff = msg.files;
        this.reviewBase = msg.base;
        break;
      case "review_status":
        this.reviewStatus = {
          status: msg.status,
          provider: msg.provider,
          model: msg.model,
          error: msg.error,
        };
        break;
      case "files_list":
        this.files = msg.files;
        break;
      case "skills_list":
        this.skills = msg.skills;
        break;
      case "skill_draft":
        this.skillDraft = { body: msg.body, error: msg.error };
        break;
    }
  }

  #send(msg: ClientToServer): void {
    this.#ws?.send(JSON.stringify(msg));
  }

  setDial(mode: DialMode): void {
    this.#send({ type: "set_dial", mode });
  }

  ack(editId: string): void {
    this.#send({ type: "ack_edit", editId });
  }

  /** Discard a pending edit. Optional reason is handed to the agent to revise. */
  rejectEdit(editId: string, reason = ""): void {
    this.conversation = [
      ...this.conversation,
      { role: "steer", text: reason ? `Rejected: ${reason}` : "Rejected edit" },
    ];
    this.#send({ type: "reject_edit", editId, reason });
  }

  /** Pin a line comment to an edit; it rides along on the next steer. */
  addLineComment(comment: LineComment): void {
    this.lineComments = [...this.lineComments, comment];
  }

  removeLineComment(id: string): void {
    this.lineComments = this.lineComments.filter((c) => c.id !== id);
  }

  clearLineComments(): void {
    this.lineComments = [];
  }

  /**
   * Steer the agent. Any pending line comments are shipped with this directive
   * and then cleared. A directive with comments but no typed text is allowed.
   */
  sendDirective(text: string, anchorEditId: string | null = null): void {
    const lineComments = this.lineComments;
    const summary =
      lineComments.length > 0
        ? `${text ? `${text}\n` : ""}(${lineComments.length} line comment${
            lineComments.length > 1 ? "s" : ""
          })`
        : text;
    this.conversation = [...this.conversation, { role: "steer", text: summary }];
    this.#send({ type: "send_directive", text, anchorEditId, lineComments });
    this.clearLineComments();
  }

  askSidecar(
    text: string,
    provider: AgentProvider | null = null,
    model: string | null = null,
  ): void {
    this.conversation = [...this.conversation, { role: "you", text }];
    this.#send({ type: "sidecar_message", text, provider, model });
  }

  /** Ask the server for the repo file list (for @file autocomplete). */
  requestFiles(): void {
    this.#send({ type: "request_files" });
  }

  // --- Skills ---

  requestSkills(): void {
    this.#send({ type: "request_skills" });
  }

  saveSkill(scope: "repo" | "user", name: string, body: string): void {
    this.#send({ type: "save_skill", scope, name, body });
  }

  /** Generate a SKILL.md draft (null provider/model = the session default). */
  draftSkill(
    prompt: string,
    provider: AgentProvider | null = null,
    model: string | null = null,
  ): void {
    this.skillDraft = null;
    this.#send({ type: "draft_skill", prompt, provider, model });
  }

  /** Cleanly halt the agent. The session pauses; sending again resumes it. */
  stop(): void {
    this.#send({ type: "stop_session" });
  }

  /** Answer the agent's open question: question text → chosen answer. */
  answerQuestion(questionId: string, answers: Record<string, string>): void {
    this.#send({ type: "answer_question", questionId, answers });
    this.question = null;
  }

  /** Approve the agent's plan (it starts executing) or request changes. */
  decidePlan(planId: string, approved: boolean, reason = ""): void {
    this.#send({ type: "decide_plan", planId, approved, reason });
    this.plan = null;
  }

  /** Focus a file and ask the server for its 1-hop dependency impact map. */
  requestImpact(path: string): void {
    if (this.impactFocus !== path) this.impactMap = null;
    this.impactFocus = path;
    this.impactLoading = true;
    this.#send({ type: "request_impact", path });
  }

  /** Ask the server for the language-server registry + install state. */
  requestLspServers(): void {
    this.#send({ type: "request_lsp_servers" });
  }

  /**
   * Install a language server on demand. Pass the focused file (from the degraded
   * map) to re-render that map afterward, or null when triggered from Settings.
   */
  installLsp(serverId: string, path: string | null = null): void {
    if (path) this.impactLoading = true;
    this.#send({ type: "install_lsp", serverId, path });
  }

  // --- Code review ---

  /** Ask the server to (re)compute the PR-format review diff. */
  requestReviewDiff(): void {
    this.#send({ type: "request_review_diff" });
  }

  /** Run the reviewer agent (null = the configured default provider/model). */
  requestReview(provider: AgentProvider | null = null, model: string | null = null): void {
    this.reviewStatus = { status: "running", provider, model, error: null };
    this.#send({ type: "request_review", provider, model });
  }

  addReviewComment(c: {
    path: string;
    side: "old" | "new";
    line: number;
    lineText: string;
    body: string;
  }): void {
    this.#send({ type: "add_review_comment", ...c });
  }

  resolveReviewComment(id: string, resolved: boolean): void {
    this.#send({ type: "resolve_review_comment", id, resolved });
  }

  deleteReviewComment(id: string): void {
    this.#send({ type: "delete_review_comment", id });
  }

  /** Send all unresolved review comments back to the coding agent as fixes. */
  submitReview(text = ""): void {
    this.conversation = [...this.conversation, { role: "steer", text: "Submitted code review" }];
    this.#send({ type: "submit_review", text });
  }

  setAutoReview(enabled: boolean): void {
    this.#send({ type: "set_auto_review", enabled });
  }
}
