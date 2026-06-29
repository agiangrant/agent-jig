import { z } from "zod";

// The shared vocabulary: the event log, the ws protocol, and config. Everything
// crossing a process/network boundary is defined here once. One event log,
// three projections.

// --- Pacing ---

/** `realtime`: gate is a no-op. `slowed`: each write-class call blocks until acked. */
export const DialMode = z.enum(["realtime", "slowed"]);
export type DialMode = z.infer<typeof DialMode>;

/** Lifecycle of one gated call: open (passed through) → pending → released | bypassed | rejected. */
export const GateState = z.enum(["open", "pending", "released", "bypassed", "rejected"]);
export type GateState = z.infer<typeof GateState>;

// --- Sessions ---

export const SessionStatus = z.enum(["running", "paused", "done", "error"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** Which coding-agent CLI/SDK governs the session. */
export const AgentProvider = z.enum(["claude", "gemini", "codex"]);
export type AgentProvider = z.infer<typeof AgentProvider>;

export const Session = z.object({
  id: z.string(),
  repoPath: z.string(),
  taskPrompt: z.string(),
  /** A short generated title for the prompt; null until generated. */
  title: z.string().nullable().default(null),
  status: SessionStatus,
  /** The agent runtime governing this session. */
  agentSdk: AgentProvider.default("claude"),
  /** Optional per-session model override; null = the provider's default. */
  agentModel: z.string().nullable().default(null),
  /** Git commit captured at session start; the base for the PR-format review diff. */
  baseRef: z.string().nullable().default(null),
  /** Run the reviewer automatically when the agent finishes (default off). */
  autoReview: z.boolean().default(false),
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
});
export type Session = z.infer<typeof Session>;

/** One provider's readiness, surfaced to the New Session UI. */
export const ProviderStatus = z.object({
  id: AgentProvider,
  label: z.string(),
  /** True when the server has credentials (or built-in auth) for this provider. */
  available: z.boolean(),
  /** Suggested model ids for the picker (the field still accepts a custom value). */
  models: z.array(z.string()).default([]),
});
export type ProviderStatus = z.infer<typeof ProviderStatus>;

export const ProvidersInfo = z.object({
  providers: z.array(ProviderStatus),
  default: AgentProvider,
});
export type ProvidersInfo = z.infer<typeof ProvidersInfo>;

/** A session plus ephemeral "needs the human" state, for the tab list. */
export const SessionSummary = Session.extend({
  /** Edits waiting on the human in this session's queue. */
  pendingEdits: z.number().int().default(0),
  /** True if the agent is blocked on an AskUserQuestion. */
  awaitingQuestion: z.boolean().default(false),
  /** True if the agent is waiting for the human to approve a plan. */
  awaitingPlan: z.boolean().default(false),
  /** True if a stopped/finished session can be resumed (a saved SDK session id). */
  resumable: z.boolean().default(false),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

// --- The event log ---

export const EventType = z.enum([
  "session_start",
  "tool_call",
  "tool_result",
  "dial_change",
  "ack",
  "out_of_band_change", // a working-tree change the agent's gated tools didn't make
  "reasoning", // captured agent "why" from the message stream (raw; feeds narration)
  "narration", // Phase 2: curated/generated why annotation
  "directive", // Phase 3
  "review_comment", // a PR-review comment (human or AI); reduced by payload id
  "session_end",
]);
export type EventType = z.infer<typeof EventType>;

/** A working-tree change not produced by a gated Edit/Write/MultiEdit. */
export const FileChange = z.object({
  path: z.string(),
  kind: z.enum(["modified", "added", "deleted"]),
});
export type FileChange = z.infer<typeof FileChange>;

export const OutOfBandChange = z.object({
  attributedTo: z.enum(["bash", "external"]),
  files: z.array(FileChange),
});
export type OutOfBandChange = z.infer<typeof OutOfBandChange>;

/** Append-only, ordered per-session by `seq`. The three projections are views over this. */
export const JigEvent = z.object({
  id: z.string(),
  sessionId: z.string(),
  seq: z.number().int(),
  ts: z.number().int(),
  type: EventType,
  toolName: z.string().nullable().default(null),
  /** Stable id for a write-class edit; what Layer 3 directives anchor to. */
  editId: z.string().nullable().default(null),
  intentGroupId: z.string().nullable().default(null), // Phase 2
  risk: z.number().min(0).max(1).nullable().default(null),
  gateState: GateState.nullable().default(null),
  payload: z.unknown(),
});
export type JigEvent = z.infer<typeof JigEvent>;

/** A set of edits grouped under the agent's stated intent (a Phase 2 projection). */
export const IntentGroup = z.object({
  id: z.string(),
  label: z.string(),
  editIds: z.array(z.string()),
});
export type IntentGroup = z.infer<typeof IntentGroup>;

/**
 * An intent group enriched with AST-sameness analysis. `pattern` is the cluster
 * of structurally-identical edits to collapse; `outliers` deviate from it.
 */
export const ChangeViewGroup = z.object({
  id: z.string(),
  label: z.string(),
  editIds: z.array(z.string()),
  pattern: z.object({ editIds: z.array(z.string()), count: z.number().int() }).nullable(),
  outliers: z.array(z.string()),
});
export type ChangeViewGroup = z.infer<typeof ChangeViewGroup>;

export const ChangeView = z.array(ChangeViewGroup);
export type ChangeView = z.infer<typeof ChangeView>;

// --- Config & blast-radius defaults ---

/** Path glob → starting dial mode. High-risk targets auto-downshift; manual override wins. */
export const RiskRule = z.object({
  id: z.string(),
  glob: z.string(),
  defaultMode: DialMode,
  risk: z.number().min(0).max(1),
});
export type RiskRule = z.infer<typeof RiskRule>;

export const SessionConfig = z.object({
  defaultMode: DialMode,
  riskRules: z.array(RiskRule),
  /** Pending-gate wait before the defer/resume fallback (SDK hook-timeout caveat). ms. */
  gateTimeoutMs: z.number().int().positive(),
});
export type SessionConfig = z.infer<typeof SessionConfig>;

export const DEFAULT_CONFIG: SessionConfig = {
  defaultMode: "slowed",
  gateTimeoutMs: 30 * 60 * 1000,
  riskRules: [
    {
      id: "auth",
      glob: "**/{auth,authn,authz,security}/**",
      defaultMode: "slowed",
      risk: 0.9,
    },
    {
      id: "migrations",
      glob: "**/migrations/**",
      defaultMode: "slowed",
      risk: 0.9,
    },
    {
      id: "billing",
      glob: "**/{billing,payments,charge}/**",
      defaultMode: "slowed",
      risk: 0.95,
    },
    {
      id: "tests",
      glob: "**/*.{test,spec}.*",
      defaultMode: "realtime",
      risk: 0.1,
    },
    {
      id: "docs",
      glob: "**/*.{md,mdx,txt}",
      defaultMode: "realtime",
      risk: 0.05,
    },
  ],
};

// --- Websocket protocol (UI <-> server) ---

/** A write-class call waiting on the human — one row in the queue timeline. */
export const PendingEdit = z.object({
  editId: z.string(),
  toolName: z.string(),
  path: z.string(),
  seq: z.number().int(),
  risk: z.number().min(0).max(1),
});
export type PendingEdit = z.infer<typeof PendingEdit>;

/**
 * A slice of a worktree file, served over HTTP (`GET /sessions/:id/file`) so the
 * browser Review tab can expand context around an edit and preview touched files.
 * `lines` is the 1-indexed inclusive range `[from, to]`; `totalLines` is the whole
 * file's line count so the client can size unexpanded gaps without fetching them.
 */
export const FileSlice = z.object({
  path: z.string(),
  totalLines: z.number().int(),
  from: z.number().int(),
  to: z.number().int(),
  lines: z.array(z.string()),
});
export type FileSlice = z.infer<typeof FileSlice>;

/** One option the agent offered for a question. */
export const QuestionOption = z.object({
  label: z.string(),
  description: z.string().default(""),
  /** Optional rich preview (markdown) for comparing options. */
  preview: z.string().optional(),
});
export type QuestionOption = z.infer<typeof QuestionOption>;

export const Question = z.object({
  /** Short chip label, e.g. "Library". */
  header: z.string(),
  /** The full question text — also the key used in the answers map. */
  question: z.string(),
  options: z.array(QuestionOption),
  multiSelect: z.boolean().default(false),
});
export type Question = z.infer<typeof Question>;

/** The agent's `AskUserQuestion`, awaiting the human — a non-write item in the queue. */
export const PendingQuestion = z.object({
  id: z.string(),
  questions: z.array(Question),
});
export type PendingQuestion = z.infer<typeof PendingQuestion>;

/** The agent's `ExitPlanMode` plan, awaiting the human's approve/revise decision. */
export const PendingPlan = z.object({
  id: z.string(),
  /** The plan text (markdown). */
  plan: z.string(),
});
export type PendingPlan = z.infer<typeof PendingPlan>;

// --- Architecture: the dependency impact map ---

/** A node in the focused-file impact map. `kind` drives its color and column. */
export const ImpactNode = z.object({
  /** Repo-relative path; for the elision node this is a synthetic id like "more:dependents". */
  path: z.string(),
  kind: z.enum(["editing", "imports-it", "it-imports", "more"]),
  /** Layout position in the 600x400 SVG viewBox (computed server-side). */
  x: z.number(),
  y: z.number(),
  /** A short label (usually the basename; for the "more" node, "+N more"). */
  label: z.string(),
  /** Sub-label, e.g. "no tests" or the elided count. */
  meta: z.string().default(""),
  /** False when neither a sibling test nor a test-file dependent covers this file. */
  hasTests: z.boolean().default(true),
  /** Edits this session made to this file (drives the warm badge on the focus node). */
  edits: z.number().int().default(0),
  /** A dependent reached by the *edited* symbol(s) — visually emphasized. */
  reachedByEdit: z.boolean().default(false),
});
export type ImpactNode = z.infer<typeof ImpactNode>;

export const ImpactEdge = z.object({
  /** Node paths (the `path` field of an ImpactNode). */
  from: z.string(),
  to: z.string(),
  /** "imports-it" = dependent→focus; "it-imports" = focus→dependency. */
  kind: z.enum(["imports-it", "it-imports"]),
  /** A back-edge to an already-visited node (circular import) — rendered, not expanded. */
  cyclic: z.boolean().default(false),
});
export type ImpactEdge = z.infer<typeof ImpactEdge>;

/**
 * The bounded 1-hop dependency neighborhood of a focused file: the file itself,
 * the files that import it (dependents), and the files it imports (dependencies).
 * A projection of the codebase graph computed lazily on focus; see @agent-jig/codegraph.
 */
export const ImpactMap = z.object({
  /** Repo-relative path of the focused file. */
  focus: z.string(),
  nodes: z.array(ImpactNode),
  edges: z.array(ImpactEdge),
  /** Distinct dependents reached by the edited symbol(s) — the "ripples to N" count. */
  rippleCount: z.number().int().default(0),
  /** True when only tree-sitter ran (no language server) — dependencies only, no dependents. */
  degraded: z.boolean().default(false),
  /** Present when a language server could be installed to lift the degraded state. */
  install: z
    .object({
      serverId: z.string(),
      languageId: z.string(),
      installing: z.boolean().default(false),
    })
    .nullable()
    .default(null),
});
export type ImpactMap = z.infer<typeof ImpactMap>;

/** One language server in the registry, with its install state for this session. */
export const LspServerInfo = z.object({
  serverId: z.string(),
  /** Human label for the language, e.g. "TypeScript / JavaScript". */
  language: z.string(),
  /** installed = ready · installable = one click away · manual = needs a toolchain. */
  status: z.enum(["installed", "installable", "manual"]),
  /** For `manual` servers: the command to install it (e.g. "rustup component add …"). */
  hint: z.string().default(""),
  /** True while an on-demand install is in flight. */
  installing: z.boolean().default(false),
});
export type LspServerInfo = z.infer<typeof LspServerInfo>;

/**
 * A human comment anchored to one line of a specific edit's diff. The first
 * slice of @mentions: the developer marks up the diff, accumulates several of
 * these across edits, and ships them with one steering directive. Anchored by
 * `editId` (not free-text) so it stays distinct from the inline `@file` mentions
 * a later slice will parse from the conversation box.
 */
export const LineComment = z.object({
  /** Client-generated id, for removal from the pending tray. */
  id: z.string(),
  /** The tool_call's editId this comment is anchored to. */
  editId: z.string(),
  /** Repo-relative file path (for display + the composed message). */
  path: z.string(),
  /** Which side of the diff the line lives on (old = deleted, new = added/context). */
  side: z.enum(["old", "new"]),
  /** 1-based file line number on that side. */
  line: z.number().int(),
  /** The line's text content (shown in the chip + given to the agent for context). */
  lineText: z.string(),
  /** The developer's comment. */
  body: z.string(),
});
export type LineComment = z.infer<typeof LineComment>;

// --- Code review (PR-format, post-completion) ---

/** Who authored a review comment: the human, or one of the agent providers. */
export const ReviewAuthor = z.union([z.literal("human"), AgentProvider]);
export type ReviewAuthor = z.infer<typeof ReviewAuthor>;

/**
 * One comment on the PR-format review diff (human or AI). Stored as a
 * `review_comment` event; add/resolve/delete re-append with the same `id`, and
 * consumers reduce by `id` taking the latest (append-only, like the log).
 */
export const ReviewComment = z.object({
  id: z.string(),
  author: ReviewAuthor,
  /** Model that produced an AI comment (null for human). */
  model: z.string().nullable().default(null),
  path: z.string(),
  /** Which side of the diff the line is on (new = added/context, old = removed). */
  side: z.enum(["old", "new"]),
  /** 1-based line number on that side of the final diff. */
  line: z.number().int(),
  lineText: z.string().default(""),
  body: z.string(),
  severity: z.enum(["info", "warning", "issue"]).default("info"),
  resolved: z.boolean().default(false),
  deleted: z.boolean().default(false),
  createdAt: z.number().int(),
});
export type ReviewComment = z.infer<typeof ReviewComment>;

/** One row of a unified review diff, carrying both sides' line numbers. */
export const ReviewDiffRow = z.object({
  kind: z.enum(["context", "add", "del"]),
  text: z.string(),
  oldLine: z.number().int().nullable(),
  newLine: z.number().int().nullable(),
});
export type ReviewDiffRow = z.infer<typeof ReviewDiffRow>;

export const ReviewHunk = z.object({
  header: z.string(),
  rows: z.array(ReviewDiffRow),
});
export type ReviewHunk = z.infer<typeof ReviewHunk>;

/** A single file's net change in the review, derived from git. */
export const ReviewFileDiff = z.object({
  path: z.string(),
  oldPath: z.string().nullable().default(null),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  hunks: z.array(ReviewHunk),
});
export type ReviewFileDiff = z.infer<typeof ReviewFileDiff>;

/** Lifecycle of an AI review run. */
export const ReviewStatus = z.enum(["idle", "running", "done", "error"]);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

// --- Skills ---

/** A skill (a SKILL.md) discovered in the repo or the user's home. */
export const Skill = z.object({
  name: z.string(),
  description: z.string().default(""),
  scope: z.enum(["repo", "user"]),
  /** Absolute path to the SKILL.md, for display/editing. */
  path: z.string(),
  body: z.string().default(""),
});
export type Skill = z.infer<typeof Skill>;

export const ServerToClient = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session_state"), session: Session }),
  z.object({ type: z.literal("event"), event: JigEvent }),
  z.object({ type: z.literal("queue_state"), pending: z.array(PendingEdit) }),
  z.object({ type: z.literal("dial_state"), mode: DialMode }),
  z.object({ type: z.literal("change_view"), view: ChangeView }),
  z.object({ type: z.literal("sidecar_reply"), text: z.string() }),
  z.object({ type: z.literal("question_state"), question: PendingQuestion.nullable() }),
  z.object({ type: z.literal("plan_state"), plan: PendingPlan.nullable() }),
  // The dependency impact map for a focused file; null while computing or when
  // unavailable. `requested` echoes the exact path the client asked about (which
  // may be absolute) so a late map for a since-changed focus can be discarded —
  // map.focus is repo-relative and would not match the request.
  z.object({ type: z.literal("impact_map"), requested: z.string(), map: ImpactMap.nullable() }),
  // The language-server registry with per-session install state (for Settings).
  z.object({ type: z.literal("lsp_servers"), servers: z.array(LspServerInfo) }),
  // Cross-session: the whole tab list with attention state, pushed live so tabs
  // (incl. inactive ones) update without waiting for the poll.
  z.object({ type: z.literal("sessions_summary"), sessions: z.array(SessionSummary) }),
  // The PR-format net diff (first edit → last) for the review panel.
  z.object({ type: z.literal("review_diff"), base: z.string(), files: z.array(ReviewFileDiff) }),
  // The reviewer agent's run state.
  z.object({
    type: z.literal("review_status"),
    status: ReviewStatus,
    provider: AgentProvider.nullable().default(null),
    model: z.string().nullable().default(null),
    error: z.string().nullable().default(null),
  }),
  // Repo-relative file paths for @file mention autocomplete in the composer.
  z.object({ type: z.literal("files_list"), files: z.array(z.string()) }),
  // The discovered skills (repo + user), for the browser and /skill autocomplete.
  z.object({ type: z.literal("skills_list"), skills: z.array(Skill) }),
  // A model-generated SKILL.md draft for the skill creator.
  z.object({
    type: z.literal("skill_draft"),
    body: z.string(),
    error: z.string().nullable().default(null),
  }),
]);
export type ServerToClient = z.infer<typeof ServerToClient>;

export const ClientToServer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_dial"), mode: DialMode }),
  z.object({ type: z.literal("ack_edit"), editId: z.string() }),
  z.object({ type: z.literal("reject_edit"), editId: z.string(), reason: z.string() }),
  z.object({
    type: z.literal("send_directive"),
    text: z.string(),
    anchorEditId: z.string().nullable().default(null),
    /** Line comments anchored to edits, shipped with this directive (Phase 1 @mentions). */
    lineComments: z.array(LineComment).default([]),
  }),
  /** Cleanly halt the agent; the session pauses and can be resumed by steering. */
  z.object({ type: z.literal("stop_session") }),
  z.object({
    type: z.literal("sidecar_message"),
    text: z.string(),
    /** Optional one-off second-opinion model (defaults to the session's sidecar). */
    provider: AgentProvider.nullable().default(null),
    model: z.string().nullable().default(null),
  }),
  /** Ask the server to (re)compute the PR-format review diff. */
  z.object({ type: z.literal("request_review_diff") }),
  /** Run the reviewer agent; null provider/model = the configured default. */
  z.object({
    type: z.literal("request_review"),
    provider: AgentProvider.nullable().default(null),
    model: z.string().nullable().default(null),
    /** Optional custom review guidance; the post-comments protocol is always injected. */
    instructions: z.string().nullable().default(null),
  }),
  /** Add a human inline review comment. */
  z.object({
    type: z.literal("add_review_comment"),
    path: z.string(),
    side: z.enum(["old", "new"]),
    line: z.number().int(),
    lineText: z.string().default(""),
    body: z.string(),
  }),
  /** Mark a review comment resolved/unresolved. */
  z.object({ type: z.literal("resolve_review_comment"), id: z.string(), resolved: z.boolean() }),
  /** Remove a review comment (tombstone). */
  z.object({ type: z.literal("delete_review_comment"), id: z.string() }),
  /** Send all unresolved review comments back to the coding agent as fixes. */
  z.object({ type: z.literal("submit_review"), text: z.string().default("") }),
  /** Toggle auto-review-on-completion for this session. */
  z.object({ type: z.literal("set_auto_review"), enabled: z.boolean() }),
  /** Ask for the repo file list (for @file mention autocomplete). */
  z.object({ type: z.literal("request_files") }),
  /** Ask for the discovered skills (repo + user). */
  z.object({ type: z.literal("request_skills") }),
  /** Create/overwrite a SKILL.md in the repo or user scope. */
  z.object({
    type: z.literal("save_skill"),
    scope: z.enum(["repo", "user"]),
    name: z.string(),
    body: z.string(),
  }),
  /** Generate a SKILL.md draft from a prompt via the chosen (or default) model. */
  z.object({
    type: z.literal("draft_skill"),
    prompt: z.string(),
    provider: AgentProvider.nullable().default(null),
    model: z.string().nullable().default(null),
  }),
  /** Ask the server for the dependency impact map of a focused file (repo-relative path). */
  z.object({ type: z.literal("request_impact"), path: z.string() }),
  /** Ask for the language-server registry + install state (e.g. when Settings opens). */
  z.object({ type: z.literal("request_lsp_servers") }),
  /**
   * Install a language server on demand. `path` (a focused file) re-renders that
   * file's impact map afterward; null when triggered from Settings.
   */
  z.object({
    type: z.literal("install_lsp"),
    serverId: z.string(),
    path: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal("answer_question"),
    questionId: z.string(),
    /** question text → chosen answer (multi-select comma-joined). */
    answers: z.record(z.string(), z.string()),
  }),
  z.object({
    type: z.literal("decide_plan"),
    planId: z.string(),
    approved: z.boolean(),
    /** Feedback when requesting changes; handed back so the agent revises. */
    reason: z.string().default(""),
  }),
]);
export type ClientToServer = z.infer<typeof ClientToServer>;
