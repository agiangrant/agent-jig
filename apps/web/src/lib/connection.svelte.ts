import type {
  ChangeView,
  ClientToServer,
  DialMode,
  GovernorEvent,
  PendingEdit,
  ServerToClient,
  Session,
} from "@governor/contracts";

/** Live view over the server's websocket stream, exposed as Svelte 5 runes. */
export class GovernorConnection {
  session = $state<Session | null>(null);
  mode = $state<DialMode>("slowed");
  queue = $state<PendingEdit[]>([]);
  events = $state<GovernorEvent[]>([]);
  changeView = $state<ChangeView>([]);
  /** One unified human↔system conversation: questions, sidecar replies, and steers. */
  conversation = $state<Array<{ role: "you" | "sidecar" | "steer"; text: string }>>([]);
  connected = $state(false);

  #ws: WebSocket | null = null;

  /** (Re)connect to a session's stream, resetting state so tabs switch cleanly. */
  connect(url: string): void {
    this.#ws?.close();
    this.session = null;
    this.mode = "slowed";
    this.queue = [];
    this.events = [];
    this.changeView = [];
    this.conversation = [];
    this.connected = false;

    const ws = new WebSocket(url);
    this.#ws = ws;
    ws.onopen = () => {
      this.connected = true;
    };
    ws.onclose = () => {
      this.connected = false;
    };
    ws.onmessage = (e) => this.#handle(JSON.parse(e.data as string) as ServerToClient);
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
      case "event":
        this.events = [...this.events, msg.event];
        break;
      case "change_view":
        this.changeView = msg.view;
        break;
      case "sidecar_reply":
        this.conversation = [...this.conversation, { role: "sidecar", text: msg.text }];
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
}
