import type { ServerToClient } from "@agent-jig/contracts";
import type { WebSocket } from "ws";

/** Tracks connected UI sockets and fans server→client messages out to them. */
export class Broadcaster {
  private readonly clients = new Set<WebSocket>();

  add(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
  }

  send(ws: WebSocket, msg: ServerToClient): void {
    ws.send(JSON.stringify(msg));
  }

  broadcast(msg: ServerToClient): void {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }
}
