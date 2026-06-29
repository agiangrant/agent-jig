import type { ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * A minimal newline-delimited JSON-RPC peer for Codex's `app-server`: we send
 * requests (start a thread/turn, steer, interrupt), receive notifications (the
 * event stream), and answer server→client *requests* (the approval gate). Gemini
 * uses the ACP SDK's own transport instead, so this is Codex-specific plumbing
 * kept generic enough to unit-test against an in-memory duplex.
 *
 * Note: Codex's framing is JSON-RPC-*shaped* but omits the `"jsonrpc": "2.0"`
 * field ("we neither send nor expect it"), so neither do we.
 */

export type JsonValue = unknown;

/** A bidirectional message channel — abstracts the child process for testing. */
export interface JsonRpcDuplex {
  send(message: JsonValue): void;
  onMessage(listener: (message: JsonValue) => void): void;
  close(): void;
}

export type RequestHandler = (params: JsonValue) => Promise<JsonValue> | JsonValue;
export type NotificationHandler = (params: JsonValue) => void;

export interface JsonRpcPeer {
  request<T = JsonValue>(method: string, params?: JsonValue): Promise<T>;
  notify(method: string, params?: JsonValue): void;
  /** Handle a server→client request (e.g. an approval). */
  onRequest(method: string, handler: RequestHandler): void;
  /** Handle a server→client notification (e.g. an event). */
  onNotification(method: string, handler: NotificationHandler): void;
  close(): void;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: JsonValue;
  result?: JsonValue;
  error?: { code: number; message: string; data?: JsonValue };
}

export function createJsonRpcPeer(duplex: JsonRpcDuplex): JsonRpcPeer {
  let nextId = 1;
  const pending = new Map<
    number | string,
    { resolve: (v: never) => void; reject: (e: Error) => void }
  >();
  const requestHandlers = new Map<string, RequestHandler>();
  const notificationHandlers = new Map<string, NotificationHandler>();

  duplex.onMessage((raw) => {
    const msg = raw as RpcMessage;
    // A response to one of our requests.
    if (msg.id !== undefined && msg.id !== null && msg.method === undefined) {
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result as never);
      return;
    }
    // An incoming request (has id + method) — answer it.
    if (msg.id !== undefined && msg.id !== null && msg.method) {
      const handler = requestHandlers.get(msg.method);
      const id = msg.id;
      if (!handler) {
        duplex.send({ id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
        return;
      }
      Promise.resolve(handler(msg.params))
        .then((result) => duplex.send({ id, result }))
        .catch((err) =>
          duplex.send({
            id,
            error: { code: -32000, message: (err as Error).message ?? "handler error" },
          }),
        );
      return;
    }
    // A notification (method, no id).
    if (msg.method) {
      notificationHandlers.get(msg.method)?.(msg.params);
    }
  });

  return {
    request<T = JsonValue>(method: string, params?: JsonValue): Promise<T> {
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: never) => void, reject });
        duplex.send({ id, method, params });
      });
    },
    notify(method: string, params?: JsonValue): void {
      duplex.send({ method, params });
    },
    onRequest(method, handler) {
      requestHandlers.set(method, handler);
    },
    onNotification(method, handler) {
      notificationHandlers.set(method, handler);
    },
    close() {
      for (const waiter of pending.values()) waiter.reject(new Error("connection closed"));
      pending.clear();
      duplex.close();
    },
  };
}

/** Frame JSON-RPC messages as newline-delimited JSON over a child process's stdio. */
export function childProcessDuplex(child: ChildProcessWithoutNullStreams): JsonRpcDuplex {
  return {
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    onMessage(listener) {
      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line.length > 0) {
            try {
              listener(JSON.parse(line));
            } catch {
              // Ignore non-JSON lines (banners, warnings) on stdout.
            }
          }
          nl = buffer.indexOf("\n");
        }
      });
    },
    close() {
      child.kill();
    },
  };
}
