<script lang="ts">
import { GovernorConnection } from "./lib/connection.svelte.ts";

const conn = new GovernorConnection();
const wsUrl = import.meta.env.VITE_WS_URL ?? `ws://${location.hostname}:4318`;
conn.connect(wsUrl);

const toggle = () => conn.setDial(conn.mode === "slowed" ? "realtime" : "slowed");

function riskLabel(r: number): "high" | "med" | "low" {
  if (r >= 0.8) return "high";
  if (r >= 0.4) return "med";
  return "low";
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

  <section class="queue">
    <h2>Queue <span class="count">{conn.queue.length}</span></h2>
    {#if conn.queue.length === 0}
      <p class="empty">Nothing waiting — the agent is working, or idle.</p>
    {:else}
      <ul>
        {#each conn.queue as edit (edit.editId)}
          <li>
            <span class="risk {riskLabel(edit.risk)}">{riskLabel(edit.risk)}</span>
            <code>{edit.path}</code>
            <span class="tool">{edit.toolName}</span>
            <button onclick={() => conn.ack(edit.editId)}>Ack</button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="timeline">
    <h2>Timeline</h2>
    <ol>
      {#each conn.events as ev (ev.id)}
        <li>
          <span class="seq">#{ev.seq}</span>
          <span class="type">{ev.type}</span>
          {#if ev.toolName}<span class="tool">{ev.toolName}</span>{/if}
          {#if ev.gateState}<span class="gate {ev.gateState}">{ev.gateState}</span>{/if}
        </li>
      {/each}
    </ol>
  </section>
</main>

<style>
  main {
    max-width: 820px;
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

  h2 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--muted);
    margin: 28px 0 10px;
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
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 12px;
    margin-bottom: 6px;
  }
  .queue code {
    flex: 1;
  }
  .queue button {
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

  .timeline li {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 3px 0;
    color: var(--muted);
  }
  .timeline .seq {
    color: var(--line);
    min-width: 42px;
  }
  .timeline .type {
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
</style>
