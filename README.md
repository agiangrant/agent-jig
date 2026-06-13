# Governor

*A pace-controlled, narrated, interruptible interface for supervised AI coding.*

Generation got cheap; **comprehension and judgment** are now the scarce resources. Governor
inserts a buffered channel with a human-controlled drain rate between a fast agent and a slow
human — with **real backpressure on the agent**, not display-only delay. You set the pace; the
agent's writes wait until you've caught up, so correction lands before consequences pile up.

See [`docs/initial_project_idea.md`](docs/initial_project_idea.md) for the full thesis and the
three-layer design (**Observe → Understand → Steer**).

## Architecture: one event log, three projections

```
  Claude Agent SDK ──▶  EVENT LOG (SQLite, ordered, gated)  ◀── directives (streamInput)
  (hosted in-proc)      intent-annotated tool calls               anchored to edit IDs
        │                    │            │            │
   canUseTool gate      OBSERVE      UNDERSTAND      STEER
   (in-mem semaphore)  paced buffer  intent diff +   sidecar +
                       + backpressure narration       anchored directives
```

Server, agent session, and SQLite all run in **one Node process**, so the pacing semaphore is a
plain in-memory primitive — no IPC.

## Packages

| Package | Responsibility |
| --- | --- |
| `@governor/contracts` | Zod schemas + types: the event log, ws protocol, config. Zero runtime deps. |
| `@governor/core` | Pure domain logic: the `Pacer` (backpressure), tool classification, blast-radius risk scoring. |
| `@governor/store` | SQLite (`better-sqlite3`) event log behind a `Storage` interface. |
| `@governor/agent-host` | Wraps the Claude Agent SDK: gates write-class tools on the `Pacer`, streams tool calls into the log, injects directives. |
| `apps/server` | Hono + `ws` gateway; embeds the agent host; serves the UI. |
| `apps/web` | Svelte 5 + Vite UI: queue timeline + dial + ack (Phase 1 projection). |
| `apps/cli` | `governor run "<task>"` — boots the server and a governed session. |

## Develop

Requires **Node 24+** and **pnpm 11+**.

```bash
pnpm install
pnpm typecheck   # tsc --noEmit across the workspace
pnpm test        # vitest
pnpm check       # biome lint + format
pnpm check:fix   # auto-fix
```

## Run it

```bash
pnpm --filter @governor/web build                 # build the UI once (served by the server)
pnpm --filter @governor/cli start -- run "your task here" --repo /path/to/target
```

**Narration** (per-edit "why" lines) uses a cheap model (Haiku) via the base Anthropic SDK,
which needs an `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) — this is separate from the
agent's own CLI auth. Without one, narration is silently off; set the key (or `GOVERNOR_NARRATE=0`
to force off) to control it.

Or, for UI development with hot reload, run the server and Vite separately:

```bash
GOVERNOR_REPO=/path/to/target GOVERNOR_TASK="your task" pnpm --filter @governor/server dev
pnpm --filter @governor/web dev                    # http://localhost:5173, talks to ws on :4318
```

## Status

Phase 1 (**Observe**) is built: the paced buffer, the websocket server, and a minimal UI
(queue timeline, dial, ack). The full three-layer architecture is designed up front; the paced
buffer ships first because it answers the one unproven hypothesis — does paced immersion feel
like flow, or like watching paint dry? Phase 2 (intent-grouped diff + narration) and Phase 3
(steering sidecar) build on the same event log.
