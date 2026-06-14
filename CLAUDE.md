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
  writes, not on thought"). An `allow` result MUST echo `updatedInput` or the SDK rejects the tool
  (see `agent-host/src/gate.ts`). **Validated:** `canUseTool` blocks *indefinitely* — held a live
  agent 75s with no timeout — so the 60s `PreToolUse`-hook timeout does NOT apply here. No
  defer/resume fallback needed; `config.gateTimeoutMs` is reserved for a future idle-policy, unused.
- **Steering** (Phase 3) = a controllable `AsyncIterable` prompt injects directives at the next
  tool-call boundary (the `Query` object has `interrupt`/`setPermissionMode`, not a `streamInput`).
- **AskUserQuestion**: the agent's built-in "ask the human" tool flows through `canUseTool`;
  *allowing* it makes the headless SDK try to render a TTY prompt (it hangs). The gate intercepts
  it, surfaces a `PendingQuestion` to the UI (`question_state`), blocks on the human's
  `answer_question`, then resolves by **denying with the answer as the message** — `canUseTool`
  can't return a tool result, so deny-with-message is the channel (same trick as steering/reject).
- Every tool call is observable on the async message iterator (`assistant` messages carry
  `tool_use` blocks) — that is the event source.

## Multi-session

The server is a **session manager**, not one session: `apps/server` hosts a `SessionManager` of `GovernedSession` bundles (each its own pacer/agent-host/sidecar/worktree/broadcaster), over one shared store/analyzer/narrator. `POST /sessions` creates, `GET /sessions` lists. Websockets are **scoped per connection** by `ws://…?session=<id>` (message shapes stay unchanged — no sessionId field). `governor run` starts a persistent server (or attaches a session to a running one via HTTP); the UI has vertical session tabs + a "New session" form and polls `GET /sessions`. The server stays up across sessions (Ctrl-C to stop).

**Persistence/reconnect.** Sessions outlive process restarts. On boot `SessionManager.restore()` rehydrates every stored session: a `running` one whose last event is within `RESUME_WINDOW_MS` (6h) and which has a captured SDK session id **resumes its agent** (`runGovernedSession({ resume })` — the SDK id is captured from the message stream's `session_id` and stored in `sessions.claude_session_id`); anything else comes back **detached** (`GovernedSession` with an inert `running` — full history/diffs replay from the store, no live agent), with interrupted `running` sessions flipped to `paused`. A `GovernedSession` thus has three modes: fresh / resume / detached. The web client persists the active session id (URL hash + localStorage) so a browser refresh reconnects to the same tab.

## Conventions

- TypeScript ESM, **Node 24+**, **pnpm** workspace. Internal packages export raw `./src/index.ts`
  (no build step); apps consume TS via tsx/Vite/vitest. Typecheck with `pnpm typecheck`.
- **Biome** for lint+format (single quotes, no semicolons, 2-space, width 100). Run `pnpm check:fix`.
- **Vitest** for tests, colocated as `*.test.ts` next to source.
- Cross-package imports use `@governor/<pkg>`; intra-package imports use explicit `.ts` extensions.
- Keep `core` pure (no I/O) — it's where the logic worth testing lives. I/O goes in `store`,
  `agent-host`, and `apps/server`.

## Narration (Phase 2.2)

`session.ts` captures the agent's reasoning as `reasoning` events; `@governor/narrator` turns
the reasoning + an edit's before/after into a one-line "why" (`narration` event), and condenses a
group's reasoning into a crisp intent label (`summarize`, used by `governed-session` to replace the
heuristic `groupByIntent` label — cached per group, generated off the hot path, re-broadcast when
ready). Default backend is Haiku via the **base `@anthropic-ai/sdk`** (needs
`ANTHROPIC_API_KEY`/`AUTH_TOKEN`, separate from the agent's CLI auth). The narrator's single
`generate` seam is **provider-agnostic**: set `GOVERNOR_LLM_BASE_URL` (+ `GOVERNOR_LLM_MODEL`,
optional `GOVERNOR_LLM_API_KEY`) to point narration/labels at any OpenAI-compatible endpoint — e.g.
a local Ollama. The server gates narration on creds-or-endpoint being present and runs it off the
hot path; `generate` is injectable (the register logic is unit-tested offline). Do **not** generate
narration via a second Agent-SDK `query()` per edit — it spawns a CLI per call and is too slow.
**Note:** this provider flexibility covers narration/labels only — the governed agent and the
sidecar run on the Claude Agent SDK (Claude-only by design).

## Build order

Phase 1 **Observe** (now): contracts + core + store + agent-host gating + server + minimal Svelte UI.
Phase 2 **Understand**: intent-grouped diff (tree-sitter) + narration. Phase 3 **Steer**: sidecar.
Architect for all three; build Phase 1 first and dogfood it.

## Don't

- Don't add display-only delay — the gate must block the *agent*, not just the screen.
- Don't gate read/search tools. Don't pipe every human utterance into the agent (Phase 3 routing).
- Don't reach for heavy frameworks; this codebase values boring, composable pieces.
