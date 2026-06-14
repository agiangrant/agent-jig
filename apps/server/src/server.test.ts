import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const wsUrl = (server: RunningServer, id: string) =>
  `${server.url.replace("http", "ws")}?session=${id}`;

let server: RunningServer;
afterEach(async () => {
  await server.close();
});

describe("startGovernorServer", () => {
  it("snapshots a session to a new client and round-trips a dial change", async () => {
    server = await startGovernorServer({ port: 0, dbPath: ":memory:", queryImpl });
    const session = server.createSession({ repoPath: tmpdir(), prompt: "t", mode: "slowed" });

    const got: ServerToClient[] = [];
    const ws = new WebSocket(wsUrl(server, session.id));
    ws.on("message", (d) => got.push(JSON.parse(String(d)) as ServerToClient));
    await new Promise<void>((res, rej) => {
      ws.on("open", () => res());
      ws.on("error", rej);
    });

    await waitFor(() => got.some((m) => m.type === "change_view"));
    const types = got.map((m) => m.type);
    expect(types).toContain("session_state");
    expect(types).toContain("dial_state");
    expect(types).toContain("queue_state");

    ws.send(JSON.stringify({ type: "set_dial", mode: "realtime" }));
    await waitFor(() => got.some((m) => m.type === "dial_state" && m.mode === "realtime"));
    ws.close();
  });

  it("rejects a websocket from a foreign origin (CSWSH guard)", async () => {
    server = await startGovernorServer({ port: 0, dbPath: ":memory:", queryImpl });
    const session = server.createSession({ repoPath: tmpdir(), prompt: "t" });
    const ws = new WebSocket(wsUrl(server, session.id), { origin: "http://evil.example" });
    const outcome = await new Promise<"open" | "rejected">((res) => {
      ws.on("open", () => res("open"));
      ws.on("error", () => res("rejected"));
      ws.on("unexpected-response", () => res("rejected"));
    });
    expect(outcome).toBe("rejected");
    ws.close();
  });

  it("creates and lists sessions over HTTP", async () => {
    server = await startGovernorServer({ port: 0, dbPath: ":memory:", queryImpl });
    const res = await fetch(`${server.url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoPath: tmpdir(), prompt: "via http" }),
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string; taskPrompt: string };
    expect(created.taskPrompt).toBe("via http");

    const list = (await (await fetch(`${server.url}/sessions`)).json()) as unknown[];
    expect(list.length).toBe(1);
  });

  it("returns the picked folder from the native chooser", async () => {
    server = await startGovernorServer({
      port: 0,
      dbPath: ":memory:",
      queryImpl,
      pickFolder: async () => "/Users/me/project",
    });
    const res = await fetch(`${server.url}/pick-folder`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { path: string }).toEqual({ path: "/Users/me/project" });
  });

  it("returns 400 when the folder pick is cancelled", async () => {
    server = await startGovernorServer({
      port: 0,
      dbPath: ":memory:",
      queryImpl,
      pickFolder: async () => null,
    });
    const res = await fetch(`${server.url}/pick-folder`);
    expect(res.status).toBe(400);
  });

  it("rehydrates sessions from the store across a server restart", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "gov-db-")), "g.db");

    const first = await startGovernorServer({ port: 0, dbPath, queryImpl });
    const created = (await (
      await fetch(`${first.url}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoPath: tmpdir(), prompt: "persist me" }),
      })
    ).json()) as { id: string };
    await first.close();

    // A fresh process (new manager, empty in-memory map) on the same DB file.
    server = await startGovernorServer({ port: 0, dbPath, queryImpl });
    const list = (await (await fetch(`${server.url}/sessions`)).json()) as {
      id: string;
      taskPrompt: string;
    }[];
    expect(list.map((s) => s.id)).toContain(created.id);
    expect(list.find((s) => s.id === created.id)?.taskPrompt).toBe("persist me");
  });

  it("renames and closes a session over HTTP", async () => {
    server = await startGovernorServer({ port: 0, dbPath: ":memory:", queryImpl });
    const created = (await (
      await fetch(`${server.url}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoPath: tmpdir(), prompt: "rename me" }),
      })
    ).json()) as { id: string };

    const patch = await fetch(`${server.url}/sessions/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Custom Name" }),
    });
    expect(patch.status).toBe(204);
    let list = (await (await fetch(`${server.url}/sessions`)).json()) as {
      id: string;
      title: string | null;
    }[];
    expect(list.find((s) => s.id === created.id)?.title).toBe("Custom Name");

    const del = await fetch(`${server.url}/sessions/${created.id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    list = (await (await fetch(`${server.url}/sessions`)).json()) as { id: string; title: null }[];
    expect(list.map((s) => s.id)).not.toContain(created.id);
  });

  it("rejects a cross-origin POST /sessions (CSRF→RCE guard)", async () => {
    server = await startGovernorServer({ port: 0, dbPath: ":memory:", queryImpl });
    const res = await fetch(`${server.url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ repoPath: tmpdir(), prompt: "x" }),
    });
    expect(res.status).toBe(403);
    const list = (await (await fetch(`${server.url}/sessions`)).json()) as unknown[];
    expect(list.length).toBe(0); // nothing created
  });
});
