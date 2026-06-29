/**
 * Provider-agnostic agent runtime. Jig governs *any* coding agent the same way:
 * a human-paced gate with real backpressure on writes, over a single event log.
 * `runJigSession` and the gate talk only to this interface — they never import a
 * vendor SDK. Phase 1 wraps the Claude Agent SDK; later adapters wrap the Gemini
 * and Codex CLIs, translating each one's protocol into this shape.
 */

/** What the Pacer-backed gate decides for a single tool call. */
export type GateDecision =
  | { allow: true; updatedInput: Record<string, unknown> }
  | { allow: false; message: string };

/**
 * Provider-agnostic permission callback — Jig's gate. Adapters translate a
 * provider's tool call into Jig's tool vocabulary (Edit/Write/Bash/…) before
 * calling this, so the gate, line-number enrichment, diff view, and narration
 * all stay unchanged across providers.
 */
export type GateFn = (toolName: string, input: Record<string, unknown>) => Promise<GateDecision>;

/**
 * Normalized stream item — only what `runJigSession`'s loop consumes. Keeping
 * this minimal is deliberate: a provider need only surface these three things.
 */
export type AgentMessage =
  /** The provider's resumable session id (emitted once, when first seen). */
  | { type: "session"; sessionId: string }
  /** A chunk of the agent's natural-language reasoning. */
  | { type: "reasoning"; text: string }
  /** A turn finished; `raw` is the provider's native result payload, logged as-is. */
  | { type: "result"; raw: unknown };

export interface AgentRunOptions {
  /** The opening turn (task prompt / resume-nudge / new instruction). */
  prompt: string;
  cwd: string;
  /** Applied to every tool call. */
  gate: GateFn;
  /** Text appended to the provider's default system prompt. */
  appendSystemPrompt?: string;
  /** Start in plan mode (agent plans; tools don't execute). Best-effort per provider. */
  planMode?: boolean;
  /** Resume a prior provider session by id. */
  resume?: string;
  /** Escape hatch for provider-specific options (e.g. Claude `Options`). */
  providerOptions?: Record<string, unknown>;
}

/** A live run: a normalized message stream plus control. */
export interface AgentRun extends AsyncIterable<AgentMessage> {
  /** Inject a steering turn mid-run. */
  send(text: string): void;
  /** Close the inbound stream so the run can complete. */
  end(): void;
  /** Switch permission mode (e.g. plan → default). Optional capability. */
  setPermissionMode?(mode: string): Promise<void>;
  interrupt(): Promise<void>;
}

export interface AgentSDK {
  run(options: AgentRunOptions): AgentRun;
}
