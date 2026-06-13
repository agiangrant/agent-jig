// Dev harness: run a real governed session and auto-ack each gated edit after a
// short beat, to demonstrate the live backpressure loop. Not part of the product.
import type { ChangeView, GovernorEvent } from "@governor/contracts";
import { startGovernorServer } from "@governor/server";
import { WebSocket } from "ws";

const repo = process.argv[2] ?? process.cwd();
const task =
  process.argv[3] ??
  "Add a one-line JSDoc comment above each function and method in the TypeScript files under src/, describing what it does. Do not change any logic.";
const ACK_DELAY_MS = Number(process.env.ACK_DELAY_MS ?? 800);

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

const server = await startGovernorServer({
  repoPath: repo,
  prompt: task,
  mode: "slowed",
  port: 0,
  dbPath: ":memory:",
});
console.log(`${ts()} server up at ${server.url} (mode: slowed)`);

const scheduled = new Set<string>();
const events: GovernorEvent[] = [];
let changeView: ChangeView = [];
const ws = new WebSocket(server.url.replace("http", "ws"));

ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.type === "event") {
    const e = msg.event as GovernorEvent;
    events.push(e);
    if (e.type === "reasoning") {
      console.log(`${ts()} #${e.seq} 💭 ${(e.payload as { text?: string })?.text ?? ""}`);
    } else {
      const tool = e.toolName ? ` ${e.toolName}` : "";
      const gate = e.gateState ? ` [${e.gateState}]` : "";
      console.log(`${ts()} #${e.seq} ${e.type}${tool}${gate}`);
    }
  } else if (msg.type === "change_view") {
    changeView = msg.view;
  } else if (msg.type === "queue_state") {
    for (const p of msg.pending) {
      if (scheduled.has(p.editId)) continue;
      scheduled.add(p.editId);
      console.log(
        `${ts()}   ⛔ GATED ${p.path} (risk ${p.risk}) — human acks in ${ACK_DELAY_MS}ms`,
      );
      setTimeout(() => {
        console.log(`${ts()}   ✅ ACK ${p.path}`);
        ws.send(JSON.stringify({ type: "ack_edit", editId: p.editId }));
      }, ACK_DELAY_MS);
    }
  }
});

await server.done;
console.log(`${ts()} session done`);

const pathOf = (editId: string): string => {
  const e = events.find((x) => x.editId === editId);
  return ((e?.payload ?? {}) as { file_path?: string }).file_path ?? "";
};

console.log(`\n=== ${changeView.length} intent group(s) ===`);
for (const g of changeView) {
  console.log(`▸ ${g.label}`);
  if (g.pattern) {
    console.log(`    ⊟ ${g.pattern.count} structurally identical edits (collapsed)`);
    for (const id of g.outliers) console.log(`    ⚠ outlier: ${pathOf(id)}`);
  } else {
    for (const id of g.editIds) console.log(`    - ${pathOf(id)}`);
  }
}

ws.close();
await server.close();
