import { existsSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { ImpactMap } from "@agent-jig/contracts";
import { layoutImpactMap, type NeighborRef } from "./layout.ts";
import { inRepo, isExcluded, pathKey, toRepoRelative } from "./resolve.ts";

export { RepoGraph } from "./graph.ts";
export type { ImportSite, SupportedLang } from "./imports.ts";
export { ImportExtractor, langForPath } from "./imports.ts";
export {
  installServer,
  listServerStatus,
  lspHome,
  resolveServer,
  type ServerStatus,
} from "./lsp/install.ts";
export { LspManager } from "./lsp/manager.ts";
export {
  allServers,
  descriptorById,
  descriptorForPath,
  type ServerDescriptor,
} from "./lsp/registry.ts";
export { LspCodeGraphProvider } from "./provider.ts";
export {
  canonical,
  inRepo,
  isExcluded,
  pathKey,
  resolveRelative,
  toRepoRelative,
} from "./resolve.ts";

/** A neighbor file the provider found, plus whether the edited symbol reached it. */
export interface FileRef {
  /** Absolute path to the neighbor file. */
  path: string;
  /** Dependents only: reached by one of the edited symbols ("this change ripples here"). */
  reachedByEdit?: boolean;
}

/** A symbol position (0-based, LSP coordinates) used to anchor the ripple search. */
export interface SymbolRef {
  name: string;
  line: number;
  character: number;
}

/**
 * The engine seam. The LSP-backed provider supplies both directions; a file in a
 * language with no installed server degrades to a tree-sitter-only provider that
 * answers `dependencies` but reports `references: false` so dependents are skipped.
 */
export interface CodeGraphProvider {
  /** Files the focus imports ("it imports"). */
  dependencies(absFile: string): Promise<FileRef[]>;
  /** Files that import the focus ("imports it"); `symbols` anchors the ripple subset. */
  dependents(absFile: string, symbols: SymbolRef[]): Promise<FileRef[]>;
  /** `references: false` ⇒ no language server ⇒ dependencies resolve statically only. */
  capabilities(absFile: string): { references: boolean };
  /** The language server that could be installed to sharpen resolution, if any. */
  installable?(absFile: string): { serverId: string; languageId: string } | null;
  /** Drop any cached import graph after the worktree changes. */
  invalidate?(): void;
}

export interface BuildInput {
  /** Absolute path to the focused file. */
  focus: string;
  /** Absolute repo/worktree root; neighbors outside it are dropped. */
  repoRoot: string;
  /** Symbols the session edited in the focus file, to anchor the ripple. */
  editedSymbols: SymbolRef[];
  /** Edits this session made to the focus file (drives its badge). */
  edits: number;
  provider: CodeGraphProvider;
  /** Max neighbors per side before "+N more" elision (default 12). */
  maxPerSide?: number;
  /** Injectable for tests; defaults to a sibling-test-file probe. */
  hasTests?: (absFile: string) => boolean;
}

/**
 * Builds the bounded 1-hop impact map for a focused file. Cycles are handled by a
 * shared `visited` set keyed on canonical path: a file that both imports and is
 * imported by the focus (a circular import) appears once as a dependency and again
 * as a *cyclic* back-edge among the dependents — rendered, never re-expanded.
 */
export async function buildImpactMap(input: BuildInput): Promise<ImpactMap> {
  const { focus, repoRoot, provider } = input;
  const probe = input.hasTests ?? siblingTestExists;
  const caps = provider.capabilities(focus);

  // Both directions come from the provider; dependents are static (no server needed).
  const [depsRaw, dependentsRaw] = await Promise.all([
    provider.dependencies(focus).catch(() => [] as FileRef[]),
    provider.dependents(focus, input.editedSymbols).catch(() => [] as FileRef[]),
  ]);

  // Dependencies first claim the visited set; dependents seen there are cyclic.
  const visited = new Set<string>([pathKey(focus)]);
  const dependencies = toNeighbors(depsRaw, repoRoot, visited, probe);
  for (const d of depsRaw) visited.add(pathKey(d.path));
  const dependents = toNeighbors(dependentsRaw, repoRoot, visited, probe);

  const focusRel = toRepoRelative(focus, repoRoot);
  const { nodes, edges } = layoutImpactMap({
    focus: {
      path: focusRel,
      label: labelFor(focusRel),
      edits: input.edits,
      hasTests: probe(focus),
    },
    dependents,
    dependencies,
    maxPerSide: input.maxPerSide,
  });

  const install = !caps.references && provider.installable ? provider.installable(focus) : null;

  return {
    focus: focusRel,
    nodes,
    edges,
    rippleCount: dependents.length,
    degraded: !caps.references,
    install: install ? { ...install, installing: false } : null,
  };
}

function toNeighbors(
  refs: FileRef[],
  repoRoot: string,
  visited: Set<string>,
  probe: (absFile: string) => boolean,
): NeighborRef[] {
  const out: NeighborRef[] = [];
  const local = new Set<string>();
  for (const r of refs) {
    if (isExcluded(r.path) || !inRepo(r.path, repoRoot)) continue;
    const key = pathKey(r.path);
    if (local.has(key)) continue; // dedupe within a side
    local.add(key);
    const rel = toRepoRelative(r.path, repoRoot);
    out.push({
      path: rel,
      label: labelFor(rel),
      hasTests: probe(r.path),
      reachedByEdit: r.reachedByEdit === true,
      cyclic: visited.has(key),
    });
  }
  return out;
}

/**
 * A short, distinguishable node label. A bare basename collides for the many
 * `index.ts` barrels a file imports, so for index/barrel files we prefix the
 * nearest meaningful parent directory (skipping `src`/`lib`/`dist`) — e.g.
 * `packages/core/src/index.ts` → `core/index.ts`.
 */
function labelFor(rel: string): string {
  const parts = rel.split("/");
  const base = parts.at(-1) ?? rel;
  if (!/^index\.\w+$/.test(base)) return base;
  let i = parts.length - 2;
  while (i > 0 && ["src", "lib", "dist"].includes(parts[i] ?? "")) i--;
  return parts[i] ? `${parts[i]}/${base}` : base;
}

const TEST_SUFFIX = /\.(test|spec)\.[^.]+$/i;

/** A file "has tests" if it is itself a test, or a sibling `<name>.test.<ext>` exists. */
function siblingTestExists(absFile: string): boolean {
  if (TEST_SUFFIX.test(absFile)) return true;
  const ext = extname(absFile);
  const stem = basename(absFile, ext);
  const dir = dirname(absFile);
  for (const kind of ["test", "spec"]) {
    if (existsSync(join(dir, `${stem}.${kind}${ext}`))) return true;
  }
  return false;
}
