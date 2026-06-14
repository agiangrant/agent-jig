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

/** Hosts many governed sessions over one shared store/analyzer/narrator. */
export class SessionManager {
  private readonly sessions = new Map<string, GovernedSession>();

  constructor(private readonly deps: ManagerDeps) {}

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
