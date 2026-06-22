# Jig — working notes for Claude

Jig is a **standalone, local-first** tool for supervised AI coding: it puts a human-paced
buffer with **real backpressure** between a fast Claude Agent SDK session and a slow human.
Read `docs/initial_project_idea.md` for the full spec; `README.md` for the architecture summary.

## The one mental model

**One event log, three projections** (Observe → Understand → Steer). There is a single
append-only, per-session-ordered event log (`@agent-jig/store`). The paced buffer, the diff view,
and the steering channel are all *views over that log*. Don't invent parallel state stores.

## Hard architectural facts (verified against the Agent SDK)

- A session can start in **plan mode** (New Session modal / `planMode`): the agent plans and tools don't execute — wired to the SDK's `permissionMode: "plan"` in `runJigSession`, persisted (`sessions.plan_mode`) so a resumed session keeps it. When the agent finishes planning it calls **`ExitPlanMode`**; the gate intercepts it (like AskUserQuestion) and surfaces a plan-approval card. **Approve** → the gate allows the tool *and* `running.setPermissionMode("default")` so execution proceeds, still paced by the dial; **Request changes** → deny-with-feedback so the agent revises. (`plan_state`/`decide_plan` messages; `awaitingPlan` tab badge.)

The whole session runs in **one Node process**: Hono+ws server + the hosted `query()` session +
  SQLite. The pacing semaphore (`Pacer` in `@agent-jig/core`) is therefore plain in-memory — **no IPC**.
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

The server is a **session manager**, not one session: `apps/server` hosts a `SessionManager` of `JigSession` bundles (each its own pacer/agent-host/sidecar/worktree/broadcaster), over one shared store/analyzer/narrator. `POST /sessions` creates, `GET /sessions` lists. Websockets are **scoped per connection** by `ws://…?session=<id>` (message shapes stay unchanged — no sessionId field). `jig run` starts a persistent server (or attaches a session to a running one via HTTP); the UI has vertical session tabs + a "New session" form and polls `GET /sessions`. The server stays up across sessions (Ctrl-C to stop). Tabs can be **renamed** (`PATCH /sessions/:id` → `manager.rename` → `JigSession.setTitle`, which sets a `titleManual` flag so a late LLM title won't clobber it) and **closed** (`DELETE /sessions/:id` → `manager.remove` → close agent + `store.deleteSession`, removing the session and its events).

**Persistence/reconnect.** Sessions outlive process restarts. On boot `SessionManager.restore()` rehydrates every stored session: a `running` one whose last event is within `RESUME_WINDOW_MS` (6h) and which has a captured SDK session id **resumes its agent** (`runJigSession({ resume })` — the SDK id is captured from the message stream's `session_id` and stored in `sessions.claude_session_id`); anything else comes back **detached** (`JigSession` with an inert `running` — full history/diffs replay from the store, no live agent), with interrupted `running` sessions flipped to `paused`. A `JigSession` thus has three modes: fresh / resume / detached. The web client persists the active session id (URL hash + localStorage) so a browser refresh reconnects to the same tab.

## Theming & code views (web)

Syntax highlighting is **Shiki** (`apps/web/src/lib/highlight.ts` — one lazily-created highlighter; grammars code-split into on-demand chunks). The whole UI is theme-able: `theme.svelte.ts` holds the reactive selection and maps a VSCode theme's `colors` onto the chrome CSS variables in `app.css` (`--bg/--fg/--panel/--line/--accent/--muted/--ok/--warn/--danger` + `--diff-add-bg/--diff-del-bg`), so chrome and code follow one theme. Built-in presets ship; users **import any VSCode theme JSON** (persisted to localStorage, loaded into the highlighter, selectable). Selection + custom themes persist. `Code.svelte` re-highlights when `theme.current` changes. `DiffView.svelte`: a **Write** renders the full new file highlighted; an **Edit/MultiEdit** renders a diff with a persisted mode (`diffMode.svelte.ts`) — side-by-side (default), unified, or before/after — with theme-derived add/del tints. Line numbers are a CSS counter on Shiki line spans (toggleable) that start at the edit's **real** file line: the gate reads the file at gate time (old content still present), finds `old_string`, and stores `startLine`/`startLines` on the tool_call event (the Edit tool itself gives no offsets).

A **Settings** panel (sidebar footer ⚙, or ⌘P → "Settings…") gathers theme, diff layout, line numbers, **UI/code fonts** (`--ui-font`/`--code-font` — any locally-installed family), **code font size** (`--code-font-size`), and **UI size** (S/M/L → `--ui-font-size`). Appearance prefs persist in `settings.svelte.ts`; `diffMode`/`theme` hold the rest. ⌘P is a command palette over the same settings + session navigation.

## Conventions

- TypeScript ESM, **Node 24+**, **pnpm** workspace. Internal packages export raw `./src/index.ts`
  (no build step); apps consume TS via tsx/Vite/vitest. Typecheck with `pnpm typecheck`.
- **Biome** for lint+format (double quotes, semicolons, 2-space, width 100). Run `pnpm check:fix`.
- **Vitest** for tests, colocated as `*.test.ts` next to source.
- Cross-package imports use `@agent-jig/<pkg>`; intra-package imports use explicit `.ts` extensions.
- Keep `core` pure (no I/O) — it's where the logic worth testing lives. I/O goes in `store`,
  `agent-host`, and `apps/server`.

## Narration (Phase 2.2)

`session.ts` captures the agent's reasoning as `reasoning` events; `@agent-jig/narrator` turns
the reasoning + an edit's before/after into a one-line "why" (`narration` event), and condenses a
group's reasoning into a crisp intent label (`summarize`, used by `jig-session` to replace the
heuristic `groupByIntent` label — cached per group, generated off the hot path, re-broadcast when
ready). Default backend is Haiku via the **base `@anthropic-ai/sdk`** (needs
`ANTHROPIC_API_KEY`/`AUTH_TOKEN`, separate from the agent's CLI auth). The narrator's single
`generate` seam is **provider-agnostic**: set `JIG_LLM_BASE_URL` (+ `JIG_LLM_MODEL`,
optional `JIG_LLM_API_KEY`) to point narration/labels at any OpenAI-compatible endpoint — e.g.
a local Ollama. The server gates narration on creds-or-endpoint being present and runs it off the
hot path; `generate` is injectable (the register logic is unit-tested offline). Do **not** generate
narration via a second Agent-SDK `query()` per edit — it spawns a CLI per call and is too slow.
**Note:** this provider flexibility covers narration/labels only — the governed agent and the
sidecar run on the Claude Agent SDK (Claude-only by design).

## Packaging (desktop)

The Tauri shell (`apps/desktop/`) is the cross-platform packager → `.dmg`/`.app`, `.msi`/NSIS,
`.deb`/`.rpm`/`.AppImage`. In **dev** (`tauri dev`, a debug build) `start_sidecar` (`src-tauri/src/lib.rs`)
runs the server straight from TS (`node --import tsx serve-headless.ts`) so edits hot-reload. A
**release** build can't ship the source tree, so `bundle:sidecar` (`apps/desktop/scripts/bundle-sidecar.mjs`,
run by the config's `beforeBuildCommand`) produces a self-contained sidecar under `src-tauri/sidecar/`:
esbuild bundles all first-party `@agent-jig/*` TS into one `server.mjs` (a plugin externalizes every
npm package, bundles only `@agent-jig/*` + relative), and `pnpm deploy --prod --legacy
--config.node-linker=hoisted` materializes a **flat** prod `node_modules` beside it. Hoisted is
required — the bundle inlines the workspace packages, so their transitive third-party deps (e.g. zod)
must resolve from the one top-level `node_modules`. Some deps **can't** be inlined and must ship on
disk: `web-tree-sitter`/`tree-sitter-wasms` (`.wasm` grammars loaded via `require.resolve`) and
`@anthropic-ai/claude-agent-sdk` (per-platform native `claude` binary). `lib.rs` prefers the bundled
`server.mjs` resource in release, falling back to the TS source. `cfg!(debug_assertions)` is the
dev/release switch. `.bin` is pruned from the shipped `node_modules` (pnpm leaves it dangling).

**Runtime decision (interim):** the packaged app **requires host Node 24+ on PATH** (`node:sqlite` is
a Node-24 builtin) — no runtime is vendored yet. `lib.rs` already resolves the login-shell PATH + node's
absolute path for GUI launches. CI (`.github/workflows/release.yml`) builds **each target on its native
runner** (macos-14 arm64, macos-13 x64, ubuntu-22.04 x64, windows-latest x64) — never cross-compiled —
because `pnpm deploy` resolves the agent SDK's native binary by the build host's os/arch, not by a Tauri
`--target`. arm64 Linux/Windows + musl are not covered yet. **Triggers:** a push to `main` (or manual
dispatch) publishes a rolling **`nightly` prerelease** (the `reset-nightly` job deletes the old one so the
tag tracks HEAD; `concurrency` cancels superseded runs); a `v*` tag push builds a **draft** stable release
to publish manually. `esbuild` is allowlisted in root
`package.json` `pnpm.onlyBuiltDependencies` so its postinstall runs in CI.

**WSL / browser fallback:** the same UI runs in a plain browser against `jig serve` (the
`platform.ts` `isTauri` seam falls back to HTTP/WS). That's the WSL story — no GUI needed in WSL; the
CLI's `openBrowser` prefers `wslview` under WSL so the Windows browser opens against WSL-forwarded
localhost. The Node server's `defaultWebRoot` (static UI) is unused in the desktop shell — Tauri serves
`frontendDist` and the Node sidecar is WS-only there.

## Build order

Phase 1 **Observe** (now): contracts + core + store + agent-host gating + server + minimal Svelte UI.
Phase 2 **Understand**: intent-grouped diff (tree-sitter) + narration. Phase 3 **Steer**: sidecar.
Architect for all three; build Phase 1 first and dogfood it.

## Don't

- Don't add display-only delay — the gate must block the *agent*, not just the screen.
- Don't gate read/search tools. Don't pipe every human utterance into the agent (Phase 3 routing).
- Don't reach for heavy frameworks; this codebase values boring, composable pieces.
