import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ReviewDiffRow, ReviewFileDiff, ReviewHunk } from "@agent-jig/contracts";

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
 * (defaults to `~/.jig/worktrees`), mainly for tests.
 */
export function createWorktree(repoPath: string, baseDir?: string): CreatedWorktree {
  const top = execFileSync("git", ["-C", repoPath, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  const id = randomUUID().slice(0, 8);
  const branch = `jig/${id}`;
  const root = baseDir ?? join(homedir(), ".jig", "worktrees");
  mkdirSync(root, { recursive: true });
  const path = join(root, `${basename(top)}-${id}`);
  execFileSync("git", ["-C", top, "worktree", "add", "-b", branch, path, "HEAD"], {
    stdio: "ignore",
  });
  return { path, branch };
}

/** The current HEAD commit of `repoPath`, captured as a session's review base. */
export function headRef(repoPath: string): string | null {
  try {
    return execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/**
 * Parse a `git diff --no-color` blob into per-file structured diffs with both
 * sides' line numbers (for the PR-format review panel + comment anchoring). Pure.
 */
export function parseGitDiff(diff: string): ReviewFileDiff[] {
  const files: ReviewFileDiff[] = [];
  let file: ReviewFileDiff | null = null;
  let hunk: ReviewHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const strip = (p: string) => p.replace(/^[ab]\//, "");

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      file = {
        path: m ? m[2] : "",
        oldPath: null,
        status: "modified",
        hunks: [],
      } as ReviewFileDiff;
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = line.slice("rename from ".length).trim();
    } else if (line.startsWith("rename to ")) {
      file.path = line.slice("rename to ".length).trim();
    } else if (line.startsWith("--- ")) {
      const p = line.slice(4).trim();
      if (p !== "/dev/null") file.oldPath = file.oldPath ?? strip(p);
    } else if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      if (p !== "/dev/null") file.path = strip(p);
    } else if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldLine = m ? Number(m[1]) : 0;
      newLine = m ? Number(m[2]) : 0;
      hunk = { header: line, rows: [] };
      file.hunks.push(hunk);
    } else if (hunk && (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"))) {
      const text = line.slice(1);
      let row: ReviewDiffRow;
      if (line.startsWith("+")) row = { kind: "add", text, oldLine: null, newLine: newLine++ };
      else if (line.startsWith("-")) row = { kind: "del", text, oldLine: oldLine++, newLine: null };
      else row = { kind: "context", text, oldLine: oldLine++, newLine: newLine++ };
      hunk.rows.push(row);
    }
    // "\ No newline at end of file", "index …", "Binary files …" → ignored.
  }
  return files;
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

  /**
   * The net change since `base` (a commit) as per-file structured diffs — the
   * PR-format "first edit → last" view. Tracked changes come from `git diff`;
   * untracked files are synthesized as whole-file additions.
   */
  diff(base: string): ReviewFileDiff[] {
    if (!this.git) return [];
    let tracked = "";
    try {
      tracked = execFileSync(
        "git",
        ["-C", this.repoPath, "diff", "--no-color", "--no-ext-diff", base, "--", "."],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      );
    } catch {
      tracked = "";
    }
    const files = parseGitDiff(tracked);
    for (const path of this.untracked()) {
      files.push(this.addedFile(path));
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  private untracked(): string[] {
    try {
      const out = execFileSync(
        "git",
        ["-C", this.repoPath, "ls-files", "--others", "--exclude-standard", "-z"],
        { encoding: "utf8" },
      );
      return out.split("\0").filter((p) => p.length > 0);
    } catch {
      return [];
    }
  }

  /** A new (untracked) file rendered as an all-additions diff. */
  private addedFile(path: string): ReviewFileDiff {
    let content = "";
    try {
      content = readFileSync(join(this.repoPath, path), "utf8");
    } catch {
      return { path, oldPath: null, status: "added", hunks: [] };
    }
    const lines = content.split("\n");
    if (lines.at(-1) === "") lines.pop(); // drop trailing-newline artifact
    const rows: ReviewDiffRow[] = lines.map((text, i) => ({
      kind: "add",
      text,
      oldLine: null,
      newLine: i + 1,
    }));
    return {
      path,
      oldPath: null,
      status: "added",
      hunks: [{ header: `@@ -0,0 +1,${rows.length} @@`, rows }],
    };
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
