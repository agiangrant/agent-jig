import { createRequire } from "node:module";
import Parser from "web-tree-sitter";

const require = createRequire(import.meta.url);

// Prebuilt WASM grammars (shared with @agent-jig/structural; no native build).
const GRAMMARS = {
  ts: "tree-sitter-wasms/out/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-wasms/out/tree-sitter-tsx.wasm",
  js: "tree-sitter-wasms/out/tree-sitter-javascript.wasm",
} as const;

export type SupportedLang = keyof typeof GRAMMARS;

/** A module specifier and the position to ask the language server to resolve. */
export interface ImportSite {
  /** Raw specifier with quotes stripped, e.g. "./foo", "@agent-jig/core". */
  specifier: string;
  /** 0-based line of a character inside the specifier string (an LSP position). */
  line: number;
  /**
   * 0-based UTF-16 character offset inside the specifier string. web-tree-sitter
   * reports columns in the same UTF-16 units LSP expects, so this position can be
   * handed to `goToDefinition` directly.
   */
  character: number;
  /** `import type` / `export type` — still a real edge, surfaced for the UI. */
  typeOnly: boolean;
}

export function langForPath(path: string): SupportedLang | null {
  if (/\.tsx$/i.test(path)) return "tsx";
  if (/\.(ts|mts|cts)$/i.test(path)) return "ts";
  if (/\.(jsx?|mjs|cjs)$/i.test(path)) return "js";
  return null;
}

/**
 * Locates every import/require/dynamic-import specifier in a source file. This is
 * the universal "where are the imports" layer — tree-sitter parses the syntax; an
 * LSP `goToDefinition` on each returned position does the actual module resolution
 * (node_modules, tsconfig paths, workspace aliases) so we never hand-roll resolvers.
 */
export class ImportExtractor {
  private constructor(
    private readonly parser: Parser,
    private readonly langs: Record<SupportedLang, Parser.Language>,
  ) {}

  static async create(): Promise<ImportExtractor> {
    await Parser.init();
    const [ts, tsx, js] = await Promise.all([
      Parser.Language.load(require.resolve(GRAMMARS.ts)),
      Parser.Language.load(require.resolve(GRAMMARS.tsx)),
      Parser.Language.load(require.resolve(GRAMMARS.js)),
    ]);
    return new ImportExtractor(new Parser(), { ts, tsx, js });
  }

  extract(source: string, lang: SupportedLang): ImportSite[] {
    this.parser.setLanguage(this.langs[lang]);
    const tree = this.parser.parse(source);
    const sites: ImportSite[] = [];
    walk(tree.rootNode, sites);
    return sites;
  }
}

function walk(node: Parser.SyntaxNode, out: ImportSite[]): void {
  const t = node.type;
  if (t === "import_statement" || t === "export_statement") {
    const src = node.childForFieldName("source");
    if (src?.type === "string") {
      pushSite(src, /^\s*(import|export)\s+type\b/.test(node.text), out);
    }
  } else if (t === "call_expression") {
    // Dynamic `import("…")` (function node type "import") or `require("…")`.
    const fn = node.childForFieldName("function");
    const args = node.childForFieldName("arguments");
    if (fn && args && (fn.type === "import" || fn.text === "require")) {
      const str = args.namedChildren.find((c) => c.type === "string");
      if (str) pushSite(str, false, out);
    }
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) walk(child, out);
  }
}

function pushSite(stringNode: Parser.SyntaxNode, typeOnly: boolean, out: ImportSite[]): void {
  const specifier = stringNode.text.replace(/^['"`]|['"`]$/g, "");
  if (specifier === "") return;
  const start = stringNode.startPosition;
  out.push({
    specifier,
    line: start.row,
    character: start.column + 1, // step inside the opening quote, onto the specifier
    typeOnly,
  });
}
