import { execFileSync } from "node:child_process";

/**
 * Repo-relative tracked files (git ls-files), for `@file` mention autocomplete.
 * Capped at 5000; returns an empty list on any failure (not a git repo, git
 * missing, etc.) so callers can render an empty dropdown rather than error.
 */
export function listRepoFiles(repoPath: string): string[] {
  try {
    const out = execFileSync("git", ["-C", repoPath, "ls-files", "-z"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return out
      .split("\0")
      .filter((f) => f.length > 0)
      .slice(0, 5000);
  } catch {
    return [];
  }
}
