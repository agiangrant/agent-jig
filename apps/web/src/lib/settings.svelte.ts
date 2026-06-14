const TAB_KEY = "governor:tabSize";
const UI_FONT_KEY = "governor:uiFont";
const CODE_FONT_KEY = "governor:codeFont";

// Default font stacks; a chosen font is prepended as the first family.
const UI_DEFAULT = 'ui-monospace, "SF Mono", Menlo, monospace';
const CODE_DEFAULT = 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

function load(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}
function clampTab(n: number): number {
  return Number.isFinite(n) ? Math.min(8, Math.max(1, Math.round(n))) : 2;
}
function fontStack(chosen: string, fallback: string): string {
  const f = chosen.trim();
  return f ? `"${f}", ${fallback}` : fallback;
}

/** Persisted appearance settings applied as CSS variables on :root. */
class Settings {
  tabSize = $state<number>(clampTab(Number(load(TAB_KEY, "2"))));
  /** Empty = use the default stack. Any locally-installed font name works. */
  uiFont = $state<string>(load(UI_FONT_KEY, ""));
  codeFont = $state<string>(load(CODE_FONT_KEY, ""));

  apply(): void {
    const r = document.documentElement.style;
    r.setProperty("--tab-size", String(this.tabSize));
    r.setProperty("--ui-font", fontStack(this.uiFont, UI_DEFAULT));
    r.setProperty("--code-font", fontStack(this.codeFont, CODE_DEFAULT));
  }

  setTabSize(n: number): void {
    this.tabSize = clampTab(n);
    persist(TAB_KEY, String(this.tabSize));
    this.apply();
  }
  setUiFont(value: string): void {
    this.uiFont = value;
    persist(UI_FONT_KEY, value);
    this.apply();
  }
  setCodeFont(value: string): void {
    this.codeFont = value;
    persist(CODE_FONT_KEY, value);
    this.apply();
  }
}

export const settings = new Settings();
