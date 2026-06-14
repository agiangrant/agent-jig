import { createHighlighter, type Highlighter } from "shiki";

// Built-in VSCode-derived themes shipped as presets. Custom themes (imported
// VSCode theme JSON) are loaded into the same highlighter at runtime.
export const BUILTIN_THEMES = [
  "github-dark",
  "github-light",
  "dracula",
  "nord",
  "one-dark-pro",
  "solarized-dark",
  "vitesse-dark",
  "vitesse-light",
  "min-light",
] as const;

const LANGS = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "html",
  "css",
  "svelte",
  "python",
  "rust",
  "go",
  "java",
  "c",
  "cpp",
  "bash",
  "yaml",
  "markdown",
  "sql",
  "toml",
];

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "json",
  html: "html",
  htm: "html",
  css: "css",
  svelte: "svelte",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  sh: "bash",
  bash: "bash",
  yml: "yaml",
  yaml: "yaml",
  md: "markdown",
  markdown: "markdown",
  sql: "sql",
  toml: "toml",
};

/** Map a file path to a highlighter language, defaulting to plain text. */
export function langFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANG[ext] ?? "text";
}

let instance: Promise<Highlighter> | null = null;

/** The shared highlighter (lazily created; loads grammars + preset themes once). */
export function getHighlighter(): Promise<Highlighter> {
  if (instance === null) {
    instance = createHighlighter({ themes: [...BUILTIN_THEMES], langs: LANGS });
  }
  return instance;
}
