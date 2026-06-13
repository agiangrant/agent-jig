import { z } from "zod";

// The shared vocabulary: the event log, the ws protocol, and config. Everything
// crossing a process/network boundary is defined here once. One event log,
// three projections.

// --- Pacing ---

/** `realtime`: gate is a no-op. `slowed`: each write-class call blocks until acked. */
export const DialMode = z.enum(["realtime", "slowed"]);
export type DialMode = z.infer<typeof DialMode>;

/** Lifecycle of one gated call: open (passed through) → pending → released | bypassed. */
export const GateState = z.enum(["open", "pending", "released", "bypassed"]);
export type GateState = z.infer<typeof GateState>;

// --- Sessions ---

export const SessionStatus = z.enum(["running", "paused", "done", "error"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const Session = z.object({
  id: z.string(),
  repoPath: z.string(),
  taskPrompt: z.string(),
  status: SessionStatus,
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
});
export type Session = z.infer<typeof Session>;

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
export const GovernorEvent = z.object({
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
export type GovernorEvent = z.infer<typeof GovernorEvent>;

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

export const ServerToClient = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session_state"), session: Session }),
  z.object({ type: z.literal("event"), event: GovernorEvent }),
  z.object({ type: z.literal("queue_state"), pending: z.array(PendingEdit) }),
  z.object({ type: z.literal("dial_state"), mode: DialMode }),
  z.object({ type: z.literal("change_view"), view: ChangeView }),
]);
export type ServerToClient = z.infer<typeof ServerToClient>;

export const ClientToServer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_dial"), mode: DialMode }),
  z.object({ type: z.literal("ack_edit"), editId: z.string() }),
]);
export type ClientToServer = z.infer<typeof ClientToServer>;
