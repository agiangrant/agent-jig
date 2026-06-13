# Governor — working notes for Claude

Governor is a **standalone, local-first** tool for supervised AI coding: it puts a human-paced
buffer with **real backpressure** between a fast Claude Agent SDK session and a slow human.
Read `docs/initial_project_idea.md` for the full spec; `README.md` for the architecture summary.

## The one mental model

**One event log, three projections** (Observe → Understand → Steer). There is a single
append-only, per-session-ordered event log (`@governor/store`). The paced buffer, the diff view,
and the steering channel are all *views over that log*. Don't invent parallel state stores.

## Hard architectural facts (verified against the Agent SDK)

- The whole session runs in **one Node process**: Hono+ws server + the hosted `query()` session +
  SQLite. The pacing semaphore (`Pacer` in `@governor/core`) is therefore plain in-memory — **no IPC**.
- **Backpressure** = the SDK `canUseTool` callback `await`s `Pacer.requestGate()` for write-class
  tools; the UI's `ack_edit` resolves it. Read/search/test tools pass freely ("backpressure on
  writes, not on thought").
- **Steering** (Phase 3) = `query.streamInput()` injects directives, applied at the next tool-call
  boundary. **Caveat:** SDK hooks have a configurable timeout (default 60s) — long human pauses need
  a generous `gateTimeoutMs` and/or the `defer`→resume fallback. Validate this in Phase 1.
- Every tool call is observable on the async message iterator (`assistant` messages carry
  `tool_use` blocks) — that is the event source.

## Conventions

- TypeScript ESM, **Node 24+**, **pnpm** workspace. Internal packages export raw `./src/index.ts`
  (no build step); apps consume TS via tsx/Vite/vitest. Typecheck with `pnpm typecheck`.
- **Biome** for lint+format (single quotes, no semicolons, 2-space, width 100). Run `pnpm check:fix`.
- **Vitest** for tests, colocated as `*.test.ts` next to source.
- Cross-package imports use `@governor/<pkg>`; intra-package imports use explicit `.ts` extensions.
- Keep `core` pure (no I/O) — it's where the logic worth testing lives. I/O goes in `store`,
  `agent-host`, and `apps/server`.

## Build order

Phase 1 **Observe** (now): contracts + core + store + agent-host gating + server + minimal Svelte UI.
Phase 2 **Understand**: intent-grouped diff (tree-sitter) + narration. Phase 3 **Steer**: sidecar.
Architect for all three; build Phase 1 first and dogfood it.

## Don't

- Don't add display-only delay — the gate must block the *agent*, not just the screen.
- Don't gate read/search tools. Don't pipe every human utterance into the agent (Phase 3 routing).
- Don't reach for heavy frameworks; this codebase values boring, composable pieces.
