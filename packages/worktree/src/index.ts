import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface CreatedWorktree {
  /** Absolute path of the new working tree — the session's repoPath. */
  path: string;
  /** The branch the worktree was created on. */
  branch: string;
}

/**
 * Create an isolated git worktree off `repoPath`'s HEAD on a fresh branch, so a
 * session can edit without touching the user's checkout or other sessions. Throws
 * if `repoPath` is not inside a git repo. `baseDir` overrides the parent dir
 * (defaults to `~/.governor/worktrees`), mainly for tests.
 */
export function createWorktree(repoPath: string, baseDir?: string): CreatedWorktree {
  const top = execFileSync("git", ["-C", repoPath, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  const id = randomUUID().slice(0, 8);
  const branch = `governor/${id}`;
  const root = baseDir ?? join(homedir(), ".governor", "worktrees");
  mkdirSync(root, { recursive: true });
  const path = join(root, `${basename(top)}-${id}`);
  execFileSync("git", ["-C", top, "worktree", "add", "-b", branch, path, "HEAD"], {
    stdio: "ignore",
  });
  return { path, branch };
}

/** Map a two-char git porcelain status code to a change kind. */
function kindOf(status: string): DetectedChange["kind"] {
  if (status.includes("D")) return "deleted";
  if (status.includes("?") || status.includes("A")) return "added";
  return "modified";
}

export interface DetectedChange {
  path: string;
  kind: "modified" | "added" | "deleted";
}

interface Entry {
  sha: string | null; // null when deleted / unreadable
  kind: DetectedChange["kind"];
}
type Snapshot = Map<string, Entry>;

/**
 * Tracks the git working tree to spot changes the agent's gated tools didn't
 * make (Bash writes, the human's editor, formatters). Hashes only the dirty set
 * git reports, so cost scales with the number of changes, not the repo size.
 */
export class Worktree {
  private readonly git: boolean;
  private prev: Snapshot = new Map();

  constructor(private readonly repoPath: string) {
    this.git = this.detectGit();
    if (this.git) this.prev = this.snapshot();
  }

  get isGit(): boolean {
    return this.git;
  }

  /**
   * Snapshot the working tree and return changes since the last call that are
   * NOT in `expectedPaths` (the agent's just-written targets).
   */
  detect(expectedPaths: string[] = []): DetectedChange[] {
    if (!this.git) return [];
    const cur = this.snapshot();
    const changes: DetectedChange[] = [];

    // git reports repo-relative paths; tool inputs give absolute ones (and macOS
    // /tmp vs /private/tmp defeats path.relative), so match by relative suffix.
    const expected = expectedPaths.map((p) => p.replaceAll("\\", "/"));
    const isExpected = (key: string) => expected.some((e) => e === key || e.endsWith(`/${key}`));

    // New or content-changed since the last checkpoint; kind comes from git's status.
    for (const [path, entry] of cur) {
      if (isExpected(path)) continue;
      const before = this.prev.get(path);
      if (before === undefined || before.sha !== entry.sha) {
        changes.push({ path, kind: entry.kind });
      }
    }
    // Was dirty before, now gone from the working tree entirely.
    for (const [path, before] of this.prev) {
      if (before.sha !== null && !cur.has(path) && !isExpected(path)) {
        changes.push({ path, kind: "deleted" });
      }
    }

    this.prev = cur;
    return changes;
  }

  private snapshot(): Snapshot {
    const snap: Snapshot = new Map();
    const out = this.gitStatus();
    for (const entry of out.split("\0")) {
      if (entry.length < 4) continue;
      const status = entry.slice(0, 2);
      const path = entry.slice(3);
      const kind = kindOf(status);
      snap.set(path, { sha: kind === "deleted" ? null : this.hash(path), kind });
    }
    return snap;
  }

  private gitStatus(): string {
    try {
      return execFileSync("git", ["-C", this.repoPath, "status", "--porcelain", "-z"], {
        encoding: "utf8",
      });
    } catch {
      return "";
    }
  }

  private hash(relPath: string): string | null {
    try {
      return createHash("sha256")
        .update(readFileSync(join(this.repoPath, relPath)))
        .digest("hex");
    } catch {
      return null;
    }
  }

  private detectGit(): boolean {
    try {
      execFileSync("git", ["-C", this.repoPath, "rev-parse", "--is-inside-work-tree"], {
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  }
}
