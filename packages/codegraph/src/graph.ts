import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type ImportExtractor, langForPath } from "./imports.ts";
import { isExcluded, pathKey, probeFile, resolveRelative } from "./resolve.ts";
import { TsPathResolver } from "./tspaths.ts";

// Cap the walk so a pathological tree can't stall a focus. Real repos are far smaller.
const MAX_FILES = 6000;

/** A workspace package: its declared name and resolved entry file. */
interface Workspace {
  name: string;
  dir: string;
  entry: string | null;
}

/**
 * The repo's import graph, built by parsing every source file's imports and
 * resolving them — relative paths *and* workspace package aliases (e.g.
 * `@scope/pkg` → that package's entry). Inverting it gives "imported by", which
 * LSP `findReferences` can't answer reliably across a monorepo (it only searches
 * the currently-loaded TS program and misses `export *` barrels). Built lazily,
 * cached until `invalidate()` (called when an edit reshapes the tree).
 */
export class RepoGraph {
  private readonly forward = new Map<string, Set<string>>(); // importer key → imported abs paths
  private readonly reverse = new Map<string, Set<string>>(); // target key → importer abs paths
  private built = false;

  constructor(
    private readonly repoRoot: string,
    private readonly extractor: ImportExtractor,
  ) {}

  /** Files that import `absFile` ("imported by"). */
  dependentsOf(absFile: string): string[] {
    this.build();
    return [...(this.reverse.get(pathKey(absFile)) ?? [])];
  }

  /** Files that `absFile` imports ("it imports"), alias-aware. */
  dependenciesOf(absFile: string): string[] {
    this.build();
    return [...(this.forward.get(pathKey(absFile)) ?? [])];
  }

  invalidate(): void {
    this.built = false;
    this.forward.clear();
    this.reverse.clear();
  }

  private build(): void {
    if (this.built) return;
    this.built = true;
    const workspaces = buildWorkspaces(this.repoRoot);
    const tsPaths = new TsPathResolver(this.repoRoot);
    for (const file of listSourceFiles(this.repoRoot)) {
      const lang = langForPath(file);
      if (!lang) continue;
      let sites: { specifier: string }[];
      try {
        sites = this.extractor.extract(readFileSync(file, "utf8"), lang);
      } catch {
        continue; // unreadable or unparseable — skip
      }
      const fromKey = pathKey(file);
      for (const site of sites) {
        const target = resolveSpecifier(site.specifier, file, workspaces, tsPaths);
        if (target === null) continue;
        const targetKey = pathKey(target);
        if (targetKey === fromKey) continue;
        add(this.forward, fromKey, target);
        add(this.reverse, targetKey, file);
      }
    }
  }
}

function add(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

/** Resolve an import specifier to an in-repo file, or null for externals/builtins. */
function resolveSpecifier(
  spec: string,
  fromFile: string,
  workspaces: Workspace[],
  tsPaths: TsPathResolver,
): string | null {
  if (spec.startsWith(".")) return resolveRelative(spec, fromFile);
  // tsconfig `paths` first (e.g. `@/x`, `@agent-jig/*`), then workspace package names
  // (covers setups with no tsconfig paths, resolving via package.json `name`).
  const mapped = tsPaths.resolve(spec, fromFile);
  if (mapped) return mapped;
  // Longest names first so `@scope/pkg-extra` wins over `@scope/pkg`.
  for (const ws of workspaces) {
    if (spec === ws.name) return ws.entry;
    if (spec.startsWith(`${ws.name}/`))
      return probeFile(resolve(ws.dir, spec.slice(ws.name.length + 1)));
  }
  return null;
}

function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0 && out.length < MAX_FILES) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (isExcluded(full)) continue; // node_modules, dist, .d.ts, …
      if (e.isDirectory()) stack.push(full);
      else if (langForPath(full)) out.push(full);
    }
  }
  return out;
}

/** Map every in-repo package.json to its name + resolved entry, for alias resolution. */
function buildWorkspaces(root: string): Workspace[] {
  const workspaces: Workspace[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!isExcluded(full)) stack.push(full);
      } else if (e.name === "package.json") {
        const ws = readWorkspace(full, dir);
        if (ws) workspaces.push(ws);
      }
    }
  }
  return workspaces.sort((a, b) => b.name.length - a.name.length);
}

function readWorkspace(pkgFile: string, dir: string): Workspace | null {
  try {
    const meta = JSON.parse(readFileSync(pkgFile, "utf8")) as {
      name?: string;
      main?: string;
      module?: string;
      exports?: unknown;
    };
    if (typeof meta.name !== "string") return null;
    return { name: meta.name, dir, entry: resolveEntry(meta, dir) };
  } catch {
    return null;
  }
}

function resolveEntry(
  meta: { main?: string; module?: string; exports?: unknown },
  dir: string,
): string | null {
  const declared = entryField(meta);
  if (declared) {
    const hit = probeFile(resolve(dir, declared));
    if (hit) return hit;
  }
  // Internal packages often export raw source with no built entry — probe the usual spots.
  return probeFile(resolve(dir, "src/index")) ?? probeFile(resolve(dir, "index"));
}

function entryField(meta: { main?: string; module?: string; exports?: unknown }): string | null {
  const dot = (meta.exports as Record<string, unknown> | undefined)?.["."] ?? meta.exports;
  const fromExports =
    typeof dot === "string"
      ? dot
      : ((dot as Record<string, string> | undefined)?.import ??
        (dot as Record<string, string> | undefined)?.default ??
        (dot as Record<string, string> | undefined)?.require);
  return fromExports ?? meta.module ?? meta.main ?? null;
}
