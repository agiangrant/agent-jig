import { realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Extensions we treat as resolvable source modules (matches the tree-sitter grammars + common siblings). */
export const SOURCE_EXTS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".pyi",
  ".go",
  ".rs",
];

/**
 * Resolve a module base path to a concrete file: the path itself (when the import
 * carried an explicit extension), `<base><ext>`, or `<base>/index<ext>`.
 */
export function probeFile(absBase: string): string | null {
  const candidates: string[] = [];
  if (SOURCE_EXTS.includes(extname(absBase))) candidates.push(absBase);
  for (const e of SOURCE_EXTS) candidates.push(absBase + e);
  for (const e of SOURCE_EXTS) candidates.push(join(absBase, `index${e}`));
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      // missing candidate — keep trying
    }
  }
  return null;
}

/** Resolve a relative specifier (`./x`, `../y`) against the importing file's directory. */
export function resolveRelative(specifier: string, fromFile: string): string | null {
  if (!specifier.startsWith(".")) return null;
  return probeFile(resolve(dirname(fromFile), specifier));
}

// Paths that are never interesting neighbors in an impact map: vendored code,
// build output, VCS metadata, and ambient type declarations (which are not the
// source you'd review).
const EXCLUDED_DIR =
  /(^|[/\\])(node_modules|\.git|dist|build|out|coverage|\.next|\.svelte-kit|\.turbo)([/\\]|$)/;

export function isExcluded(absPath: string): boolean {
  if (EXCLUDED_DIR.test(absPath)) return true;
  if (/\.d\.ts$/i.test(absPath)) return true;
  return false;
}

/**
 * The real, symlink-resolved path. Worktrees live under `~/.jig/worktrees`
 * which may itself be symlinked, so canonicalizing is what makes cycle detection
 * and cross-side dedupe reliable. Falls back to a plain resolve when the file
 * doesn't exist (e.g. an unresolved import target).
 */
export function canonical(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

/** Stable dedupe/visited key: canonical path, lowercased for case-insensitive filesystems. */
export function pathKey(p: string): string {
  return canonical(p).toLowerCase();
}

/** True when `absPath` is inside `repoRoot` (both canonicalized). */
export function inRepo(absPath: string, repoRoot: string): boolean {
  const rel = relative(canonical(repoRoot), canonical(absPath));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Repo-relative, forward-slashed path for display and as the node id. */
export function toRepoRelative(absPath: string, repoRoot: string): string {
  return relative(canonical(repoRoot), canonical(absPath)).split(sep).join("/");
}
