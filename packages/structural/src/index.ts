import { createRequire } from "node:module";
import Parser from "web-tree-sitter";

const require = createRequire(import.meta.url);

// Prebuilt WASM grammars (no native compilation; ABI-independent; browser-capable).
const GRAMMARS = {
  ts: "tree-sitter-wasms/out/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-wasms/out/tree-sitter-tsx.wasm",
  js: "tree-sitter-wasms/out/tree-sitter-javascript.wasm",
} as const;

export interface EditForAnalysis {
  editId: string;
  path: string;
  oldString: string;
  newString: string;
}

export interface GroupAnalysis {
  /** The largest cluster of structurally-identical transforms (>= 2 edits), if any. */
  pattern: { editIds: string[]; count: number } | null;
  /** Edits that deviate from the dominant pattern — the judgment sites. */
  outliers: string[];
}

export class StructuralAnalyzer {
  private constructor(
    private readonly parser: Parser,
    private readonly langs: Record<keyof typeof GRAMMARS, Parser.Language>,
  ) {}

  static async create(): Promise<StructuralAnalyzer> {
    await Parser.init();
    const [ts, tsx, js] = await Promise.all([
      Parser.Language.load(require.resolve(GRAMMARS.ts)),
      Parser.Language.load(require.resolve(GRAMMARS.tsx)),
      Parser.Language.load(require.resolve(GRAMMARS.js)),
    ]);
    return new StructuralAnalyzer(new Parser(), { ts, tsx, js });
  }

  analyzeGroup(edits: EditForAnalysis[]): GroupAnalysis {
    const bySignature = new Map<string, string[]>();
    for (const edit of edits) {
      const sig = this.signature(edit);
      if (sig === null) continue;
      const list = bySignature.get(sig) ?? [];
      list.push(edit.editId);
      bySignature.set(sig, list);
    }

    let dominant: string[] | null = null;
    for (const list of bySignature.values()) {
      if (list.length >= 2 && (dominant === null || list.length > dominant.length)) {
        dominant = list;
      }
    }
    if (dominant === null) return { pattern: null, outliers: [] };

    const inPattern = new Set(dominant);
    const outliers = edits.map((e) => e.editId).filter((id) => !inPattern.has(id));
    return { pattern: { editIds: dominant, count: dominant.length }, outliers };
  }

  /**
   * A transform's structural signature: the parser's S-expression of node *types*
   * (identifiers and literals erased) for the before and after code. Two edits
   * share a signature iff their syntactic shape is identical — so "12 identical
   * call-site updates" cluster, while a deviation (extra arg, different
   * construct) does not. AST-level sameness, not text similarity.
   */
  private signature(edit: EditForAnalysis): string | null {
    const language = this.languageFor(edit.path);
    if (language === null) return null;
    this.parser.setLanguage(language);
    const before = this.parser.parse(edit.oldString).rootNode.toString();
    const after = this.parser.parse(edit.newString).rootNode.toString();
    return `${before}⇒${after}`;
  }

  private languageFor(path: string): Parser.Language | null {
    if (/\.tsx$/i.test(path)) return this.langs.tsx;
    if (/\.(ts|mts|cts)$/i.test(path)) return this.langs.ts;
    if (/\.(jsx?|mjs|cjs)$/i.test(path)) return this.langs.js;
    return null;
  }
}
