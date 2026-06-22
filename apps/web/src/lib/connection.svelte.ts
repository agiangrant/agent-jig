import type {
  ChangeView,
  ClientToServer,
  DialMode,
  ImpactMap,
  JigEvent,
  LspServerInfo,
  PendingEdit,
  PendingPlan,
  PendingQuestion,
  ServerToClient,
  Session,
  SessionSummary,
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
  connected = $state(false);
  /** A human-readable error to surface as a toast; cleared by the UI. */
  lastError = $state<string | null>(null);

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

  sendDirective(text: string, anchorEditId: string | null = null): void {
    this.conversation = [...this.conversation, { role: "steer", text }];
    this.#send({ type: "send_directive", text, anchorEditId });
  }

  askSidecar(text: string): void {
    this.conversation = [...this.conversation, { role: "you", text }];
    this.#send({ type: "sidecar_message", text });
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
}
