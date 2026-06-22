import { type Dirent, readdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import ts from "typescript";
import { isExcluded, probeFile } from "./resolve.ts";

interface PathsConfig {
  /** Directory of the tsconfig that governs files beneath it. */
  dir: string;
  /** Absolute base for resolving `paths` substitutions. */
  baseUrl: string;
  paths: Record<string, string[]>;
}

/**
 * Resolves bare specifiers through `tsconfig.json` `compilerOptions.paths` — e.g.
 * `@/x` to `src/x`, or `@agent-jig/foo` to its mapped source. The TypeScript API
 * parses each config so `extends` chains, JSONC, and `baseUrl` are handled exactly
 * as `tsc` would; we then apply the standard path-mapping rules. Configs are read
 * once (no file globbing — `readDirectory` is stubbed) and the resolver is rebuilt
 * only when the graph is invalidated.
 */
export class TsPathResolver {
  private readonly configs: PathsConfig[];

  constructor(repoRoot: string) {
    this.configs = loadConfigs(repoRoot);
  }

  /** Resolve a non-relative specifier via the nearest governing tsconfig, or null. */
  resolve(spec: string, fromFile: string): string | null {
    for (const cfg of this.configs) {
      // Deepest-first: the first config containing the file is authoritative.
      if (within(cfg.dir, fromFile)) return matchPaths(spec, cfg);
    }
    return null;
  }
}

function within(dir: string, file: string): boolean {
  const prefix = dir.endsWith(sep) ? dir : dir + sep;
  return file.startsWith(prefix);
}

function loadConfigs(repoRoot: string): PathsConfig[] {
  // Stub readDirectory so config parsing resolves extends/compilerOptions without
  // globbing every project's files.
  const host: ts.ParseConfigFileHost = {
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: () => [],
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    onUnRecoverableConfigFileDiagnostic: () => {},
  };
  const out: PathsConfig[] = [];
  for (const cfgPath of findTsConfigs(repoRoot)) {
    let options: ts.CompilerOptions | undefined;
    try {
      options = ts.getParsedCommandLineOfConfigFile(cfgPath, undefined, host)?.options;
    } catch {
      continue;
    }
    if (!options?.paths) continue;
    const dir = dirname(cfgPath);
    out.push({ dir, baseUrl: resolve(dir, options.baseUrl ?? "."), paths: options.paths });
  }
  return out.sort((a, b) => b.dir.length - a.dir.length);
}

function findTsConfigs(root: string): string[] {
  const out: string[] = [];
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
      } else if (/^tsconfig(\.[^.]+)?\.json$/.test(e.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

function matchPaths(spec: string, cfg: PathsConfig): string | null {
  for (const [pattern, targets] of Object.entries(cfg.paths)) {
    const star = matchStar(spec, pattern);
    if (star === undefined) continue;
    for (const target of targets) {
      const sub = star === null ? target : target.replace("*", star);
      const hit = probeFile(resolve(cfg.baseUrl, sub));
      if (hit) return hit;
    }
  }
  return null;
}

/** `null` = exact (starless) match; a string = the `*` capture; `undefined` = no match. */
function matchStar(spec: string, pattern: string): string | null | undefined {
  const star = pattern.indexOf("*");
  if (star === -1) return spec === pattern ? null : undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (
    spec.length >= prefix.length + suffix.length &&
    spec.startsWith(prefix) &&
    spec.endsWith(suffix)
  ) {
    return spec.slice(prefix.length, spec.length - suffix.length);
  }
  return undefined;
}
