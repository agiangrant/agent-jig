import type {
  EventType,
  GateState,
  GovernorEvent,
  Session,
  SessionConfig,
  SessionStatus,
} from "@governor/contracts";

export interface NewSession {
  repoPath: string;
  taskPrompt: string;
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

  /** Appends an event, assigning id/seq/ts, and returns the stored row. */
  appendEvent(event: NewEvent): GovernorEvent;
  listEvents(sessionId: string): GovernorEvent[];

  getConfig(): SessionConfig;
  setConfig(config: SessionConfig): void;

  close(): void;
}
