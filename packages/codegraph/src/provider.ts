import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { RepoGraph } from "./graph.ts";
import { ImportExtractor, langForPath } from "./imports.ts";
import type { CodeGraphProvider, FileRef } from "./index.ts";
import { resolveServer } from "./lsp/install.ts";
import { LspManager, type ServerHandle } from "./lsp/manager.ts";
import { descriptorForPath } from "./lsp/registry.ts";

/**
 * The default code-graph provider. Both edge directions come from a static import
 * graph (`RepoGraph`) parsed with tree-sitter and resolved alias-aware — reliable
 * across a monorepo and `export *` barrels, where LSP `findReferences` is not. The
 * language server, when installed, sharpens the *dependencies* direction via precise
 * `goToDefinition` (full tsconfig path resolution); without one, dependencies fall
 * back to the same static graph.
 */
export class LspCodeGraphProvider implements CodeGraphProvider {
  constructor(
    private readonly repoRoot: string,
    private readonly manager: LspManager,
    private readonly extractor: ImportExtractor,
    private readonly graph: RepoGraph,
  ) {}

  static async create(repoRoot: string): Promise<LspCodeGraphProvider> {
    const extractor = await ImportExtractor.create();
    return new LspCodeGraphProvider(
      repoRoot,
      new LspManager(repoRoot),
      extractor,
      new RepoGraph(repoRoot, extractor),
    );
  }

  capabilities(absFile: string): { references: boolean } {
    const desc = descriptorForPath(absFile);
    return { references: desc !== null && resolveServer(desc, this.repoRoot) !== null };
  }

  installable(absFile: string): { serverId: string; languageId: string } | null {
    const desc = descriptorForPath(absFile);
    if (!desc || resolveServer(desc, this.repoRoot) !== null) return null;
    return { serverId: desc.serverId, languageId: desc.languageId(extname(absFile).toLowerCase()) };
  }

  async dependencies(absFile: string): Promise<FileRef[]> {
    // Base: the static graph (relative + workspace-alias aware) — reliable and not
    // subject to LSP project-load warmup.
    const out = new Map<string, FileRef>();
    for (const path of this.graph.dependenciesOf(absFile)) out.set(path.toLowerCase(), { path });

    // Enrich: a language server resolves specifiers the static resolver can't (e.g.
    // non-workspace tsconfig `paths` aliases). Additive — never removes static edges.
    const lang = langForPath(absFile);
    const source = read(absFile);
    if (lang && source) {
      const handle = await this.handle(absFile);
      if (handle) {
        handle.client.didOpen(absFile, handle.languageId, source);
        for (const s of this.extractor.extract(source, lang)) {
          const locs = await handle.client
            .definition(absFile, { line: s.line, character: s.character })
            .catch(() => []);
          for (const loc of locs) {
            const path = fileURLToPath(loc.uri);
            out.set(path.toLowerCase(), { path });
          }
        }
      }
    }
    return [...out.values()];
  }

  /**
   * Files that import the focus ("imported by"), from the inverted static import
   * graph. Deterministic and monorepo-wide — unlike LSP references, which only see
   * the loaded TS program and miss `export *` barrels and cross-package importers.
   */
  async dependents(absFile: string): Promise<FileRef[]> {
    return this.graph.dependentsOf(absFile).map((path) => ({ path }));
  }

  /** Drop the cached import graph after the worktree changes. */
  invalidate(): void {
    this.graph.invalidate();
  }

  /** Shut down any spawned language servers (called when the session closes). */
  dispose(): void {
    this.manager.dispose();
  }

  private async handle(absFile: string): Promise<ServerHandle | null> {
    const result = await this.manager.handleFor(absFile);
    return "client" in result ? result : null;
  }
}

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
