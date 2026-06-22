import { extname } from "node:path";

/**
 * How a server is obtained on demand, from wherever it's actually hosted:
 * - `npm`   — a Node-based server installed into `~/.jig/lsp/<serverId>` via
 *             the npm that ships with the running Node (no global npm / PATH needed).
 * - `github`— a self-contained native binary downloaded from a GitHub release
 *             archive (`<bin>-<target-triple>.tar.gz` / `.zip`).
 * - `manual`— toolchain-distributed (gopls, rust-analyzer); detected on PATH, and
 *             if absent surfaced with an install hint rather than auto-downloaded.
 */
export type InstallSpec =
  | { kind: "npm"; pkg: string; version: string }
  | { kind: "github"; repo: string }
  | { kind: "manual"; hint: string };

export interface ServerDescriptor {
  serverId: string;
  /** Human-readable language label for the install UI. */
  language: string;
  extensions: string[];
  /** Executable/binary name (the GitHub asset prefix, the PATH name to detect). */
  bin: string;
  /** Arguments that put the server in stdio LSP mode. */
  args: string[];
  install: InstallSpec;
  /** The LSP `languageId` for a given file extension. */
  languageId(ext: string): string;
}

const DESCRIPTORS: ServerDescriptor[] = [
  {
    // vtsls: the most complete TS/JS LSP wrapper (full references + documentSymbol,
    // which the impact map's dependents direction needs). tsgo/native-preview is
    // faster but preview-only and still lacks references — swap it in later.
    serverId: "vtsls",
    language: "TypeScript / JavaScript",
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    bin: "vtsls",
    args: ["--stdio"],
    install: { kind: "npm", pkg: "@vtsls/language-server", version: "latest" },
    languageId(ext) {
      if (ext === ".tsx") return "typescriptreact";
      if (ext === ".jsx") return "javascriptreact";
      if (/^\.(js|mjs|cjs)$/.test(ext)) return "javascript";
      return "typescript";
    },
  },
  {
    // ty: Astral's Rust-based Python type checker + language server. Standalone
    // native binary (no Node), LSP via `ty server`.
    serverId: "ty",
    language: "Python",
    extensions: [".py", ".pyi"],
    bin: "ty",
    args: ["server"],
    install: { kind: "github", repo: "astral-sh/ty" },
    languageId: () => "python",
  },
  {
    serverId: "gopls",
    language: "Go",
    extensions: [".go"],
    bin: "gopls",
    args: ["serve"],
    install: { kind: "manual", hint: "go install golang.org/x/tools/gopls@latest" },
    languageId: () => "go",
  },
  {
    serverId: "rust-analyzer",
    language: "Rust",
    extensions: [".rs"],
    bin: "rust-analyzer",
    args: [],
    install: { kind: "manual", hint: "rustup component add rust-analyzer" },
    languageId: () => "rust",
  },
];

export function allServers(): ServerDescriptor[] {
  return DESCRIPTORS;
}

export function descriptorForPath(path: string): ServerDescriptor | null {
  const ext = extname(path).toLowerCase();
  return DESCRIPTORS.find((d) => d.extensions.includes(ext)) ?? null;
}

export function descriptorById(serverId: string): ServerDescriptor | null {
  return DESCRIPTORS.find((d) => d.serverId === serverId) ?? null;
}
