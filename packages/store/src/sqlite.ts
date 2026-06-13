import { randomUUID } from "node:crypto";
import {
  DEFAULT_CONFIG,
  type GovernorEvent,
  type Session,
  type SessionConfig,
  type SessionStatus,
} from "@governor/contracts";
import Database from "better-sqlite3";
import type { NewEvent, NewSession, Storage } from "./types.ts";

const CONFIG_KEY = "session_config";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  repo_path    TEXT NOT NULL,
  task_prompt  TEXT NOT NULL,
  status       TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES sessions(id),
  seq              INTEGER NOT NULL,
  ts               INTEGER NOT NULL,
  type             TEXT NOT NULL,
  tool_name        TEXT,
  edit_id          TEXT,
  intent_group_id  TEXT,
  risk             REAL,
  gate_state       TEXT,
  payload          TEXT,
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events (session_id, seq);

CREATE TABLE IF NOT EXISTS config (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`;

interface EventRow {
  id: string;
  session_id: string;
  seq: number;
  ts: number;
  type: string;
  tool_name: string | null;
  edit_id: string | null;
  intent_group_id: string | null;
  risk: number | null;
  gate_state: string | null;
  payload: string | null;
}

interface SessionRow {
  id: string;
  repo_path: string;
  task_prompt: string;
  status: string;
  started_at: number;
  ended_at: number | null;
}

function rowToEvent(r: EventRow): GovernorEvent {
  return {
    id: r.id,
    sessionId: r.session_id,
    seq: r.seq,
    ts: r.ts,
    type: r.type as GovernorEvent["type"],
    toolName: r.tool_name,
    editId: r.edit_id,
    intentGroupId: r.intent_group_id,
    risk: r.risk,
    gateState: r.gate_state as GovernorEvent["gateState"],
    payload: r.payload === null ? null : JSON.parse(r.payload),
  };
}

function rowToSession(r: SessionRow): Session {
  return {
    id: r.id,
    repoPath: r.repo_path,
    taskPrompt: r.task_prompt,
    status: r.status as SessionStatus,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

export class SqliteStorage implements Storage {
  private readonly db: Database.Database;

  /** @param path a file path, or `:memory:` for an ephemeral store. */
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  createSession(input: NewSession): Session {
    const session: Session = {
      id: randomUUID(),
      repoPath: input.repoPath,
      taskPrompt: input.taskPrompt,
      status: "running",
      startedAt: Date.now(),
      endedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO sessions (id, repo_path, task_prompt, status, started_at, ended_at)
         VALUES (@id, @repoPath, @taskPrompt, @status, @startedAt, @endedAt)`,
      )
      .run(session);
    return session;
  }

  getSession(id: string): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | SessionRow
      | undefined;
    return row === undefined ? null : rowToSession(row);
  }

  setSessionStatus(id: string, status: SessionStatus, endedAt: number | null = null): void {
    this.db
      .prepare("UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?")
      .run(status, endedAt, id);
  }

  appendEvent(event: NewEvent): GovernorEvent {
    const insert = this.db.transaction((e: NewEvent): GovernorEvent => {
      const { seq } = this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE session_id = ?")
        .get(e.sessionId) as { seq: number };

      const stored: GovernorEvent = {
        id: randomUUID(),
        sessionId: e.sessionId,
        seq,
        ts: Date.now(),
        type: e.type,
        toolName: e.toolName ?? null,
        editId: e.editId ?? null,
        intentGroupId: e.intentGroupId ?? null,
        risk: e.risk ?? null,
        gateState: e.gateState ?? null,
        payload: e.payload ?? null,
      };

      this.db
        .prepare(
          `INSERT INTO events
             (id, session_id, seq, ts, type, tool_name, edit_id, intent_group_id, risk, gate_state, payload)
           VALUES (@id, @sessionId, @seq, @ts, @type, @toolName, @editId, @intentGroupId, @risk, @gateState, @payload)`,
        )
        .run({ ...stored, payload: JSON.stringify(stored.payload ?? null) });

      return stored;
    });
    return insert(event);
  }

  listEvents(sessionId: string): GovernorEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE session_id = ? ORDER BY seq ASC")
      .all(sessionId) as EventRow[];
    return rows.map(rowToEvent);
  }

  getConfig(): SessionConfig {
    const row = this.db.prepare("SELECT value FROM config WHERE key = ?").get(CONFIG_KEY) as
      | { value: string }
      | undefined;
    return row === undefined ? DEFAULT_CONFIG : (JSON.parse(row.value) as SessionConfig);
  }

  setConfig(config: SessionConfig): void {
    this.db
      .prepare(
        `INSERT INTO config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(CONFIG_KEY, JSON.stringify(config));
  }

  close(): void {
    this.db.close();
  }
}
