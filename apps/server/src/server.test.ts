import { tmpdir } from "node:os";
import type { ServerToClient } from "@governor/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { RunningServer, ServerOptions } from "./server.ts";
import { startGovernorServer } from "./server.ts";

// A query() stand-in that drives no tools and finishes immediately.
function fakeQuery(): unknown {
  async function* gen(): AsyncGenerator<never, void> {
    /* no messages */
  }
  return Object.assign(gen(), {
    interrupt: async () => {},
    setPermissionMode: async () => {},
    setModel: async () => {},
  });
}
const queryImpl = (() => fakeQuery()) as unknown as ServerOptions["queryImpl"];

const waitFor = async (pred: () => boolean, ms = 1000): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

let server: RunningServer;

afterEach(async () => {
  await server.close();
});

describe("startGovernorServer", () => {
  it("snapshots state to a new client and round-trips a dial change", async () => {
    server = await startGovernorServer({
      repoPath: tmpdir(),
      prompt: "t",
      port: 0,
      dbPath: ":memory:",
      mode: "slowed",
      queryImpl,
    });

    const got: ServerToClient[] = [];
    const ws = new WebSocket(server.url.replace("http", "ws"));
    ws.on("message", (d) => got.push(JSON.parse(String(d)) as ServerToClient));
    await new Promise<void>((res, rej) => {
      ws.on("open", () => res());
      ws.on("error", rej);
    });

    await waitFor(() => got.some((m) => m.type === "queue_state"));
    const types = got.map((m) => m.type);
    expect(types).toContain("session_state");
    expect(types).toContain("dial_state");
    expect(types).toContain("queue_state");

    ws.send(JSON.stringify({ type: "set_dial", mode: "realtime" }));
    await waitFor(() => got.some((m) => m.type === "dial_state" && m.mode === "realtime"));

    ws.close();
  });

  it("rejects a websocket handshake from a foreign origin (CSWSH guard)", async () => {
    server = await startGovernorServer({
      repoPath: tmpdir(),
      prompt: "t",
      port: 0,
      dbPath: ":memory:",
      queryImpl,
    });

    const ws = new WebSocket(server.url.replace("http", "ws"), {
      origin: "http://evil.example",
    });
    const outcome = await new Promise<"open" | "rejected">((res) => {
      ws.on("open", () => res("open"));
      ws.on("error", () => res("rejected"));
      ws.on("unexpected-response", () => res("rejected"));
    });

    expect(outcome).toBe("rejected");
    ws.close();
  });
});
