import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  DEFAULT_CONFIG,
  type GateState,
  type JigEvent,
  type Session,
  type SessionConfig,
  type SessionStatus,
} from "@agent-jig/contracts";
import type { NewEvent, NewSession, Storage } from "./types.ts";

// `node:sqlite` is an experimental builtin in Node 24 that emits a one-time
// process warning the first time it loads. Suppress only that warning (pass
// everything else through), then load the module via `require` so the override
// is installed first — a static `import` would instantiate the builtin during
// linking, before any module body runs. Remove once node:sqlite stabilizes.
const passThroughWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const name =
    warning instanceof Error
      ? warning.name
      : typeof rest[0] === "string"
        ? rest[0]
        : (rest[0] as { type?: string } | undefined)?.type;
  const message = warning instanceof Error ? warning.message : String(warning);
  if (name === "ExperimentalWarning" && message.includes("SQLite")) return;
  return (passThroughWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

const CONFIG_KEY = "session_config";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id                 TEXT PRIMARY KEY,
  repo_path          TEXT NOT NULL,
  task_prompt        TEXT NOT NULL,
  title              TEXT,
  claude_session_id  TEXT,
  plan_mode          INTEGER,
  status             TEXT NOT NULL,
  started_at         INTEGER NOT NULL,
  ended_at           INTEGER
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
  title: string | null;
  status: string;
  started_at: number;
  ended_at: number | null;
}

function rowToEvent(r: EventRow): JigEvent {
  return {
    id: r.id,
    sessionId: r.session_id,
    seq: r.seq,
    ts: r.ts,
    type: r.type as JigEvent["type"],
    toolName: r.tool_name,
    editId: r.edit_id,
    intentGroupId: r.intent_group_id,
    risk: r.risk,
    gateState: r.gate_state as JigEvent["gateState"],
    payload: r.payload === null ? null : JSON.parse(r.payload),
  };
}

function rowToSession(r: SessionRow): Session {
  return {
    id: r.id,
    repoPath: r.repo_path,
    taskPrompt: r.task_prompt,
    title: r.title,
    status: r.status as SessionStatus,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

export class SqliteStorage implements Storage {
  private readonly db: DatabaseSyncType;

  /** @param path a file path, or `:memory:` for an ephemeral store. */
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Run `fn` inside a transaction. node:sqlite has no `db.transaction()` helper
   * (better-sqlite3 did); since `DatabaseSync` is fully synchronous, a plain
   * BEGIN/COMMIT wrapper preserves the same atomicity with no interleaving.
   */
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Additive migrations for stores created before a column existed. */
  private migrate(): void {
    const cols = this.db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    const has = (name: string) => cols.some((c) => c.name === name);
    if (!has("title")) this.db.exec("ALTER TABLE sessions ADD COLUMN title TEXT");
    if (!has("claude_session_id")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN claude_session_id TEXT");
    }
    if (!has("plan_mode")) this.db.exec("ALTER TABLE sessions ADD COLUMN plan_mode INTEGER");
  }

  createSession(input: NewSession): Session {
    const session: Session = {
      id: randomUUID(),
      repoPath: input.repoPath,
      taskPrompt: input.taskPrompt,
      title: null,
      status: "running",
      startedAt: Date.now(),
      endedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO sessions (id, repo_path, task_prompt, title, plan_mode, status, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.repoPath,
        session.taskPrompt,
        session.title,
        input.planMode ? 1 : 0,
        session.status,
        session.startedAt,
        session.endedAt,
      );
    return session;
  }

  getSession(id: string): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | SessionRow
      | undefined;
    return row === undefined ? null : rowToSession(row);
  }

  listSessions(): Session[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions ORDER BY started_at ASC")
      .all() as unknown as SessionRow[];
    return rows.map(rowToSession);
  }

  setClaudeSessionId(id: string, claudeId: string): void {
    this.db.prepare("UPDATE sessions SET claude_session_id = ? WHERE id = ?").run(claudeId, id);
  }

  getClaudeSessionId(id: string): string | null {
    const row = this.db.prepare("SELECT claude_session_id FROM sessions WHERE id = ?").get(id) as
      | { claude_session_id: string | null }
      | undefined;
    return row?.claude_session_id ?? null;
  }

  getPlanMode(id: string): boolean {
    const row = this.db.prepare("SELECT plan_mode FROM sessions WHERE id = ?").get(id) as
      | { plan_mode: number | null }
      | undefined;
    return row?.plan_mode === 1;
  }

  setSessionStatus(id: string, status: SessionStatus, endedAt: number | null = null): void {
    this.db
      .prepare("UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?")
      .run(status, endedAt, id);
  }

  deleteSession(id: string): void {
    // Events FK-reference sessions, so clear them first (one transaction).
    this.tx(() => {
      this.db.prepare("DELETE FROM events WHERE session_id = ?").run(id);
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    });
  }

  setSessionTitle(id: string, title: string): void {
    this.db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(title, id);
  }

  setEventGateState(eventId: string, gateState: GateState | null): void {
    this.db.prepare("UPDATE events SET gate_state = ? WHERE id = ?").run(gateState, eventId);
  }

  appendEvent(event: NewEvent): JigEvent {
    return this.tx((): JigEvent => {
      const { seq } = this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE session_id = ?")
        .get(event.sessionId) as { seq: number };

      const stored: JigEvent = {
        id: randomUUID(),
        sessionId: event.sessionId,
        seq,
        ts: Date.now(),
        type: event.type,
        toolName: event.toolName ?? null,
        editId: event.editId ?? null,
        intentGroupId: event.intentGroupId ?? null,
        risk: event.risk ?? null,
        gateState: event.gateState ?? null,
        payload: event.payload ?? null,
      };

      this.db
        .prepare(
          `INSERT INTO events
             (id, session_id, seq, ts, type, tool_name, edit_id, intent_group_id, risk, gate_state, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          stored.id,
          stored.sessionId,
          stored.seq,
          stored.ts,
          stored.type,
          stored.toolName,
          stored.editId,
          stored.intentGroupId,
          stored.risk,
          stored.gateState,
          JSON.stringify(stored.payload ?? null),
        );

      return stored;
    });
  }

  listEvents(sessionId: string): JigEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE session_id = ? ORDER BY seq ASC")
      .all(sessionId) as unknown as EventRow[];
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
