import { resolve } from "node:path";
import type { RunSessionDeps } from "@governor/agent-host";
import type { DialMode, Session } from "@governor/contracts";
import type { Narrator } from "@governor/narrator";
import type { Storage } from "@governor/store";
import type { StructuralAnalyzer } from "@governor/structural";
import { createWorktree } from "@governor/worktree";
import { GovernedSession } from "./governed-session.ts";

export interface ManagerDeps {
  store: Storage;
  analyzer: StructuralAnalyzer | null;
  narrator: Narrator | null;
  queryImpl?: RunSessionDeps["queryImpl"];
}

export interface CreateInput {
  repoPath: string;
  prompt: string;
  mode?: DialMode;
  /** Run the session in a fresh git worktree (isolating it from the checkout). */
  worktree?: boolean;
}

/** Only auto-resume sessions whose last activity is this recent (else view-only). */
const RESUME_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Hosts many governed sessions over one shared store/analyzer/narrator. */
export class SessionManager {
  private readonly sessions = new Map<string, GovernedSession>();

  constructor(private readonly deps: ManagerDeps) {}

  /**
   * Rehydrate sessions persisted in the store (e.g. after a dev-server restart).
   * A recently-active `running` session with a captured SDK id resumes its agent;
   * everything else comes back detached (view-only) so it's never lost from the UI.
   */
  restore(now: number = Date.now()): void {
    for (const session of this.deps.store.listSessions()) {
      if (this.sessions.has(session.id)) continue;
      const gs = this.rehydrate(session, now);
      if (gs) this.sessions.set(session.id, gs);
    }
  }

  private rehydrate(session: Session, now: number): GovernedSession | null {
    const claudeId = this.deps.store.getClaudeSessionId(session.id);
    const events = this.deps.store.listEvents(session.id);
    const lastTs = events.at(-1)?.ts ?? session.startedAt;
    const resumable =
      session.status === "running" && claudeId !== null && now - lastTs <= RESUME_WINDOW_MS;

    if (resumable) {
      try {
        return new GovernedSession({
          session,
          store: this.deps.store,
          analyzer: this.deps.analyzer,
          narrator: this.deps.narrator,
          queryImpl: this.deps.queryImpl,
          resumeClaudeId: claudeId ?? undefined,
        });
      } catch {
        // Worktree/repo gone, etc. — fall through to a view-only reconnect.
      }
    }

    // Detached: reconnectable history, no live agent. An interrupted `running`
    // session that can't resume is marked paused so it isn't retried every boot.
    if (session.status === "running") this.deps.store.setSessionStatus(session.id, "paused");
    try {
      return new GovernedSession({
        session: this.deps.store.getSession(session.id) ?? session,
        store: this.deps.store,
        analyzer: this.deps.analyzer,
        narrator: this.deps.narrator,
        queryImpl: this.deps.queryImpl,
        detached: true,
      });
    } catch {
      return null; // unrecoverable — skip, don't break boot
    }
  }

  create(input: CreateInput): Session {
    // A worktree-backed session edits an isolated checkout; its path becomes the
    // session's repoPath, so the agent cwd, diff tracker, and sidecar all follow.
    const repoPath = input.worktree
      ? createWorktree(resolve(input.repoPath)).path
      : resolve(input.repoPath);
    const session = this.deps.store.createSession({
      repoPath,
      taskPrompt: input.prompt,
    });
    const gs = new GovernedSession({
      session,
      mode: input.mode,
      store: this.deps.store,
      analyzer: this.deps.analyzer,
      narrator: this.deps.narrator,
      queryImpl: this.deps.queryImpl,
    });
    this.sessions.set(session.id, gs);
    return gs.meta();
  }

  list(): Session[] {
    return [...this.sessions.values()].map((s) => s.meta());
  }

  get(id: string): GovernedSession | undefined {
    return this.sessions.get(id);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.close()));
  }
}
