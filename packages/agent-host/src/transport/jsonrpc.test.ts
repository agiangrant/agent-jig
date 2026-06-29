import { describe, expect, it } from "vitest";
import { createJsonRpcPeer, type JsonRpcDuplex } from "./jsonrpc.ts";

/** A duplex you can inspect (sent) and drive (emit incoming messages). */
function fakeDuplex() {
  const sent: unknown[] = [];
  let listener: ((m: unknown) => void) | null = null;
  const duplex: JsonRpcDuplex = {
    send: (m) => sent.push(m),
    onMessage: (l) => {
      listener = l;
    },
    close: () => {},
  };
  return { duplex, sent, emit: (m: unknown) => listener?.(m) };
}

describe("createJsonRpcPeer", () => {
  it("correlates a request with its response", async () => {
    const { duplex, sent, emit } = fakeDuplex();
    const peer = createJsonRpcPeer(duplex);

    const p = peer.request("thread/start", { cwd: "/r" });
    expect(sent[0]).toEqual({ id: 1, method: "thread/start", params: { cwd: "/r" } });
    expect(sent[0]).not.toHaveProperty("jsonrpc");

    emit({ id: 1, result: { threadId: "t1" } });
    expect(await p).toEqual({ threadId: "t1" });
  });

  it("rejects a request when the response is an error", async () => {
    const { duplex, emit } = fakeDuplex();
    const peer = createJsonRpcPeer(duplex);
    const p = peer.request("x");
    emit({ id: 1, error: { code: -1, message: "nope" } });
    await expect(p).rejects.toThrow("nope");
  });

  it("answers an incoming server→client request via the handler", async () => {
    const { duplex, sent, emit } = fakeDuplex();
    const peer = createJsonRpcPeer(duplex);
    peer.onRequest("item/fileChange/requestApproval", async () => ({ decision: "accept" }));

    emit({ id: 99, method: "item/fileChange/requestApproval", params: {} });
    await new Promise((r) => setTimeout(r, 0));

    expect(sent.at(-1)).toEqual({ id: 99, result: { decision: "accept" } });
  });

  it("dispatches notifications (no id) to the notification handler", () => {
    const { duplex, emit } = fakeDuplex();
    const peer = createJsonRpcPeer(duplex);
    const seen: unknown[] = [];
    peer.onNotification("codex/event", (p) => seen.push(p));

    emit({ method: "codex/event", params: { kind: "turn.completed" } });
    expect(seen).toEqual([{ kind: "turn.completed" }]);
  });

  it("returns method-not-found for an unhandled incoming request", async () => {
    const { duplex, sent, emit } = fakeDuplex();
    createJsonRpcPeer(duplex);
    emit({ id: 5, method: "unknown" });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.at(-1)).toMatchObject({ id: 5, error: { code: -32601 } });
  });
});
