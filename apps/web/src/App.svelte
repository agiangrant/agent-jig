<script lang="ts">
import type { GovernorEvent } from "@governor/contracts";
import DiffView from "./lib/DiffView.svelte";
import { GovernorConnection } from "./lib/connection.svelte.ts";

const conn = new GovernorConnection();
// Same-origin when served by the governor server (any --port); dev sets VITE_WS_URL.
const wsUrl = import.meta.env.VITE_WS_URL ?? `ws://${location.host}`;
conn.connect(wsUrl);

const toggle = () => conn.setDial(conn.mode === "slowed" ? "realtime" : "slowed");

function editEvent(editId: string): GovernorEvent | undefined {
  return conn.events.find((e) => e.editId === editId && e.type === "tool_call");
}
function filePath(payload: unknown): string {
  return ((payload ?? {}) as { file_path?: string }).file_path ?? "";
}
function pathFor(editId: string): string {
  return filePath(editEvent(editId)?.payload);
}
function narrationFor(editId: string): string {
  const e = conn.events.find((x) => x.type === "narration" && x.editId === editId);
  return ((e?.payload ?? {}) as { text?: string }).text ?? "";
}
function riskLabel(r: number): "high" | "med" | "low" {
  if (r >= 0.8) return "high";
  if (r >= 0.4) return "med";
  return "low";
}
function outOfBand(p: unknown): { attributedTo: string; files: { path: string; kind: string }[] } {
  const v = (p ?? {}) as { attributedTo?: string; files?: { path: string; kind: string }[] };
  return { attributedTo: v.attributedTo ?? "external", files: v.files ?? [] };
}
function text(p: unknown): string {
  return ((p ?? {}) as { text?: string }).text ?? "";
}

// One compose box, two destinations: Ask (sidecar) and Send→agent (directive).
let message = $state("");
let anchor = $state(""); // optional editId to attach a "re:" reference

function ask() {
  const t = message.trim();
  if (!t) return;
  conn.askSidecar(anchor ? `Regarding the edit to ${pathFor(anchor)}: ${t}` : t);
  message = "";
}
function steer() {
  const t = message.trim();
  if (!t) return;
  conn.sendDirective(t, anchor || null);
  message = "";
}
</script>

<main>
  <header>
    <div class="title">
      <h1>Governor</h1>
      <span class="conn" class:on={conn.connected}>{conn.connected ? "live" : "offline"}</span>
    </div>
    <button class="dial" class:slowed={conn.mode === "slowed"} onclick={toggle}>
      {conn.mode === "slowed" ? "◐ Slowed" : "● Real-time"}
    </button>
  </header>

  {#if conn.session}
    <p class="task">{conn.session.taskPrompt}</p>
  {/if}

  <div class="cols">
    <section class="left">
      <h2>Queue <span class="count">{conn.queue.length}</span></h2>
      {#if conn.queue.length === 0}
        <p class="empty">Nothing waiting — the agent is working, or idle.</p>
      {:else}
        <ul>
          {#each conn.queue as edit (edit.editId)}
            <li>
              <div class="row">
                <span class="risk {riskLabel(edit.risk)}">{riskLabel(edit.risk)}</span>
                <code>{edit.path}</code>
                <span class="tool">{edit.toolName}</span>
                <button onclick={() => conn.ack(edit.editId)}>Ack</button>
              </div>
              <DiffView toolName={edit.toolName} payload={editEvent(edit.editId)?.payload} />
            </li>
          {/each}
        </ul>
      {/if}

      <h2>Changes by intent</h2>
      {#if conn.changeView.length === 0}
        <p class="empty">No edits yet.</p>
      {:else}
        {#each conn.changeView as g (g.id)}
          <div class="group">
            <p class="label">{g.label}</p>
            {#if g.pattern}
              {@const rep = editEvent(g.pattern.editIds[0] ?? "")}
              <div class="edit collapsed">
                <span class="badge">⊟ {g.pattern.count} structurally identical edits</span>
                <code>{filePath(rep?.payload)} + {g.pattern.count - 1} more</code>
                {#if narrationFor(g.pattern.editIds[0] ?? "")}
                  <p class="why-line">💬 {narrationFor(g.pattern.editIds[0] ?? "")}</p>
                {/if}
                <DiffView toolName={rep?.toolName ?? ""} payload={rep?.payload} />
              </div>
              {#each g.outliers as id (id)}
                {@const e = editEvent(id)}
                <div class="edit outlier">
                  <span class="badge warn">⚠ differs from the pattern — worth a look</span>
                  <code>{filePath(e?.payload)}</code>
                  {#if narrationFor(id)}<p class="why-line">💬 {narrationFor(id)}</p>{/if}
                  <DiffView toolName={e?.toolName ?? ""} payload={e?.payload} />
                </div>
              {/each}
            {:else}
              {#each g.editIds as id (id)}
                {@const e = editEvent(id)}
                <div class="edit">
                  <code>{filePath(e?.payload)}</code>
                  {#if narrationFor(id)}<p class="why-line">💬 {narrationFor(id)}</p>{/if}
                  <DiffView toolName={e?.toolName ?? ""} payload={e?.payload} />
                </div>
              {/each}
            {/if}
          </div>
        {/each}
      {/if}

      <details class="history">
        <summary>History · {conn.events.length} events</summary>
        <ol>
          {#each conn.events as ev (ev.id)}
            {#if ev.type === "out_of_band_change"}
              <li class="oob">
                <span class="seq">#{ev.seq}</span>
                <span class="warn">⚠ changed outside the agent ({outOfBand(ev.payload).attributedTo})</span>
                <span class="files">{outOfBand(ev.payload).files.map((f) => f.path).join(", ")}</span>
              </li>
            {:else if ev.type === "reasoning"}
              <li class="reason"><span class="seq">#{ev.seq}</span><span class="why">{text(ev.payload)}</span></li>
            {:else if ev.type === "directive"}
              <li class="directive"><span class="seq">#{ev.seq}</span><span class="arrow">→ steer</span><span class="dtext">{text(ev.payload)}</span></li>
            {:else}
              <li>
                <span class="seq">#{ev.seq}</span>
                <span class="etype">{ev.type}</span>
                {#if ev.toolName}<span class="tool">{ev.toolName}</span>{/if}
                {#if ev.gateState}<span class="gate {ev.gateState}">{ev.gateState}</span>{/if}
              </li>
            {/if}
          {/each}
        </ol>
      </details>
    </section>

    <aside class="right">
      <h2>Conversation</h2>
      <div class="chat">
        {#if conn.conversation.length === 0}
          <p class="empty">Ask about provenance, or steer the agent.</p>
        {/if}
        {#each conn.conversation as m, i (i)}
          <div class="msg {m.role}">
            {#if m.role === "sidecar"}<span class="tag">sidecar</span>{/if}
            {#if m.role === "steer"}<span class="tag steer">→ sent to agent</span>{/if}
            {m.text}
          </div>
        {/each}
      </div>
      <form
        class="compose"
        onsubmit={(e) => {
          e.preventDefault();
          steer();
        }}
      >
        <input type="text" bind:value={message} placeholder="Ask about provenance, or steer the agent…" />
        <div class="actions">
          <select bind:value={anchor} title="Attach a reference to a pending edit">
            <option value="">re: (none)</option>
            {#each conn.queue as e (e.editId)}<option value={e.editId}>re: {e.path}</option>{/each}
          </select>
          <button type="button" class="ask" onclick={ask}>Ask</button>
          <button type="submit" class="send">Send → agent</button>
        </div>
      </form>
    </aside>
  </div>
</main>

<style>
  main {
    max-width: 1140px;
    margin: 0 auto;
    padding: 24px 20px 64px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--line);
    padding-bottom: 12px;
  }
  .title {
    display: flex;
    align-items: baseline;
    gap: 12px;
  }
  h1 {
    font-size: 18px;
    margin: 0;
    letter-spacing: 0.5px;
  }
  .conn {
    font-size: 11px;
    color: var(--muted);
    text-transform: uppercase;
  }
  .conn.on {
    color: var(--ok);
  }
  .dial {
    background: var(--panel);
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 6px 16px;
    cursor: pointer;
    font: inherit;
  }
  .dial.slowed {
    border-color: var(--warn);
    color: var(--warn);
  }
  .task {
    color: var(--muted);
    border-left: 2px solid var(--line);
    padding-left: 12px;
  }

  .cols {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 360px;
    gap: 28px;
    align-items: start;
  }
  .right {
    position: sticky;
    top: 16px;
  }

  h2 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--muted);
    margin: 24px 0 10px;
  }
  .count {
    color: var(--accent);
  }
  .empty {
    color: var(--muted);
    font-style: italic;
  }
  ul,
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .queue li {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 12px;
    margin-bottom: 6px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .row code {
    flex: 1;
  }
  .row button {
    background: var(--accent);
    color: #0c0d12;
    border: 0;
    border-radius: 6px;
    padding: 4px 14px;
    cursor: pointer;
    font: inherit;
    font-weight: 600;
  }

  .risk {
    font-size: 10px;
    text-transform: uppercase;
    padding: 2px 6px;
    border-radius: 4px;
    border: 1px solid var(--line);
  }
  .risk.high {
    color: var(--danger);
    border-color: var(--danger);
  }
  .risk.med {
    color: var(--warn);
    border-color: var(--warn);
  }
  .risk.low {
    color: var(--muted);
  }
  .tool {
    color: var(--muted);
    font-size: 12px;
  }

  .group {
    border-left: 2px solid var(--accent);
    padding-left: 12px;
    margin-bottom: 18px;
  }
  .group .label {
    color: var(--fg);
    font-weight: 600;
    margin: 0 0 8px;
  }
  .group .edit {
    margin-bottom: 8px;
  }
  .group .edit code {
    color: var(--muted);
    font-size: 12px;
  }
  .badge {
    display: inline-block;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 4px;
    border: 1px solid var(--line);
    color: var(--muted);
    margin-right: 8px;
  }
  .badge.warn {
    color: var(--warn);
    border-color: var(--warn);
  }
  .edit.outlier {
    border-left: 2px solid var(--warn);
    padding-left: 10px;
  }
  .why-line {
    color: var(--accent);
    font-style: italic;
    margin: 6px 0;
    opacity: 0.9;
  }

  .history {
    margin-top: 28px;
    border-top: 1px solid var(--line);
    padding-top: 8px;
  }
  .history summary {
    cursor: pointer;
    color: var(--muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
  }
  .history li {
    display: flex;
    gap: 10px;
    align-items: baseline;
    padding: 3px 0;
    color: var(--muted);
  }
  .history .seq {
    color: var(--line);
    min-width: 42px;
  }
  .history .etype {
    color: var(--fg);
  }
  .gate {
    font-size: 10px;
    text-transform: uppercase;
  }
  .gate.pending {
    color: var(--warn);
  }
  .gate.released {
    color: var(--ok);
  }
  .gate.bypassed {
    color: var(--muted);
  }
  .oob .warn {
    color: var(--warn);
  }
  .reason .why {
    color: var(--accent);
    font-style: italic;
    opacity: 0.85;
  }
  .directive .arrow {
    color: var(--accent);
    font-weight: 600;
  }

  .chat {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 10px;
    max-height: 60vh;
    overflow-y: auto;
  }
  .msg {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 12px;
    max-width: 90%;
    white-space: pre-wrap;
    font-size: 13px;
  }
  .msg.you {
    align-self: flex-end;
    background: var(--panel);
  }
  .msg.sidecar {
    align-self: flex-start;
    background: #0f1015;
  }
  .msg.steer {
    align-self: flex-end;
    border-color: var(--accent);
  }
  .tag {
    display: block;
    font-size: 10px;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 2px;
  }
  .tag.steer {
    color: var(--accent);
  }

  .compose {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .compose input {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 12px;
    color: var(--fg);
    font: inherit;
  }
  .actions {
    display: flex;
    gap: 8px;
  }
  .actions select {
    flex: 1;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 6px 8px;
    color: var(--fg);
    font: inherit;
    min-width: 0;
  }
  .actions button {
    border-radius: 8px;
    padding: 0 14px;
    cursor: pointer;
    font: inherit;
  }
  .actions .ask {
    background: var(--panel);
    color: var(--fg);
    border: 1px solid var(--line);
  }
  .actions .send {
    background: var(--accent);
    color: #0c0d12;
    border: 0;
    font-weight: 600;
  }
</style>
