# Jig

*A pace-controlled, narrated, interruptible interface for supervised AI coding.*

Generation got cheap; **comprehension and judgment** are now the scarce resources. Jig
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
| `@agent-jig/contracts` | Zod schemas + types: the event log, ws protocol, config. Zero runtime deps. |
| `@agent-jig/core` | Pure domain logic: the `Pacer` (backpressure), tool classification, blast-radius risk scoring. |
| `@agent-jig/store` | SQLite (`better-sqlite3`) event log behind a `Storage` interface. |
| `@agent-jig/agent-host` | Wraps the Claude Agent SDK: gates write-class tools on the `Pacer`, streams tool calls into the log, injects directives. |
| `apps/server` | Hono + `ws` gateway; embeds the agent host; serves the UI. |
| `apps/web` | Svelte 5 + Vite UI: queue timeline + dial + ack (Phase 1 projection). |
| `apps/cli` | `jig run "<task>"` — boots the server and a governed session. |

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
pnpm --filter @agent-jig/web build                 # build the UI once (served by the server)
pnpm --filter @agent-jig/cli start -- run "your task here" --repo /path/to/target
```

**Narration** (per-edit "why" lines + intent-group labels) uses a cheap model (Haiku) via the
base Anthropic SDK, which needs an `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) — separate
from the agent's own CLI auth. Without one, narration is silently off; set the key (or
`JIG_NARRATE=0` to force off) to control it. To run narration/labels on **any
OpenAI-compatible endpoint** (e.g. a local Ollama) instead, set `JIG_LLM_BASE_URL` (plus
`JIG_LLM_MODEL`, and `JIG_LLM_API_KEY` if the endpoint needs one). The governed agent
itself still runs on the Claude Agent SDK.

### Dev mode (hot reload)

One command starts both the server (auto-restarts on change) and the Vite UI (HMR), so edits
don't need a relaunch:

```bash
pnpm dev          # server on :4318, UI on http://localhost:5173 (talks to ws on :4318)
```

It starts clean — create sessions from the UI's **New Session** modal. To also spin up one
session at boot, set `JIG_REPO=/path/to/target` (and optionally `JIG_TASK="…"`).
Server code changes restart the process (sessions reset); UI changes hot-reload in place.

## Desktop app

Prebuilt installers (macOS `.dmg`, Windows `.msi`/`.exe`, Linux `.deb`/`.rpm`/`.AppImage`) are
published on the [Releases](../../releases) page — a rolling **nightly** prerelease per push to
`main`, plus stable `v*` tags. Each is built on its native runner.

> **Requires [Node.js](https://nodejs.org) 24+ on your PATH.** The app runs a local Node sidecar
> (`node:sqlite` is a Node 24 builtin); without it the app won't start. (Bundling a runtime so this
> isn't needed is planned.)

The builds are currently **unsigned**, so each OS warns on first launch — a one-time step:

- **macOS** — after moving Jig to Applications, clear the quarantine flag:
  `xattr -dr com.apple.quarantine /Applications/Jig.app` (or right-click → Open, then
  System Settings → Privacy & Security → Open Anyway).
- **Windows** — on the SmartScreen prompt: **More info → Run anyway**.
- **Linux** — AppImage: `chmod +x Jig_*.AppImage` then run; `.deb`/`.rpm` install normally.

## Status

Phase 1 (**Observe**) is built: the paced buffer, the websocket server, and a minimal UI
(queue timeline, dial, ack). The full three-layer architecture is designed up front; the paced
buffer ships first because it answers the one unproven hypothesis — does paced immersion feel
like flow, or like watching paint dry? Phase 2 (intent-grouped diff + narration) and Phase 3
(steering sidecar) build on the same event log.
