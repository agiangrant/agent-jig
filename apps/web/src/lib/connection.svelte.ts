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
  sidecar = $state<Array<{ role: "user" | "assistant"; text: string }>>([]);
  connected = $state(false);

  #ws: WebSocket | null = null;

  connect(url: string): void {
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
        this.sidecar = [...this.sidecar, { role: "assistant", text: msg.text }];
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

  sendDirective(text: string, anchorEditId: string | null = null): void {
    this.#send({ type: "send_directive", text, anchorEditId });
  }

  askSidecar(text: string): void {
    this.sidecar = [...this.sidecar, { role: "user", text }];
    this.#send({ type: "sidecar_message", text });
  }
}
