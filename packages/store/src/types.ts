import type {
  EventType,
  GateState,
  JigEvent,
  Session,
  SessionConfig,
  SessionStatus,
} from "@agent-jig/contracts";

export interface NewSession {
  repoPath: string;
  taskPrompt: string;
  /** Start the agent in plan mode (it plans; tools don't execute). */
  planMode?: boolean;
}

/** An event before the store assigns id/seq/ts. */
export interface NewEvent {
  sessionId: string;
  type: EventType;
  payload: unknown;
  toolName?: string | null;
  editId?: string | null;
  intentGroupId?: string | null;
  risk?: number | null;
  gateState?: GateState | null;
}

/** Persistence boundary for the event log; an interface so a future store can swap in. */
export interface Storage {
  createSession(input: NewSession): Session;
  getSession(id: string): Session | null;
  listSessions(): Session[];
  setSessionStatus(id: string, status: SessionStatus, endedAt?: number | null): void;
  setSessionTitle(id: string, title: string): void;
  /** Permanently remove a session and its events. */
  deleteSession(id: string): void;
  /** The SDK's own session id, captured for cross-process resume. */
  setClaudeSessionId(id: string, claudeId: string): void;
  getClaudeSessionId(id: string): string | null;
  /** Whether the session was started in plan mode (preserved across resume). */
  getPlanMode(id: string): boolean;

  /** Appends an event, assigning id/seq/ts, and returns the stored row. */
  appendEvent(event: NewEvent): JigEvent;
  /** Update a stored event's gate state (e.g. a resolved question is no longer pending). */
  setEventGateState(eventId: string, gateState: GateState | null): void;
  listEvents(sessionId: string): JigEvent[];

  getConfig(): SessionConfig;
  setConfig(config: SessionConfig): void;

  close(): void;
}
