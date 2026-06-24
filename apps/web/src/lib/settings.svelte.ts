const UI_FONT_KEY = "jig:uiFont";
const CODE_FONT_KEY = "jig:codeFont";
const CODE_SIZE_KEY = "jig:codeFontSize";
const UI_SIZE_KEY = "jig:uiSize";
const DENSITY_KEY = "jig:density";

export type UiSize = "small" | "medium" | "large";
const UI_SIZE_PX: Record<UiSize, number> = { small: 13, medium: 14, large: 17 };

/** Component spacing scale, roomy → tight. `normal` is the default; `calm` is
 *  roomier, `dense` is extra-compact for small screens. */
export type Density = "calm" | "normal" | "dense";
const DENSITIES: readonly Density[] = ["calm", "normal", "dense"];

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
function clampCodeSize(n: number): number {
  return Number.isFinite(n) ? Math.min(28, Math.max(9, Math.round(n))) : 12;
}
function loadUiSize(): UiSize {
  const v = load(UI_SIZE_KEY, "medium");
  return v === "small" || v === "large" ? v : "medium";
}
function loadDensity(): Density {
  const v = load(DENSITY_KEY, "normal") as Density;
  return DENSITIES.includes(v) ? v : "normal";
}
function fontStack(chosen: string, fallback: string): string {
  const f = chosen.trim();
  return f ? `"${f}", ${fallback}` : fallback;
}

/** Persisted appearance settings applied as CSS variables on :root. */
class Settings {
  /** Empty = use the default stack. Any locally-installed font name works. */
  uiFont = $state<string>(load(UI_FONT_KEY, ""));
  codeFont = $state<string>(load(CODE_FONT_KEY, ""));
  codeFontSize = $state<number>(clampCodeSize(Number(load(CODE_SIZE_KEY, "12"))));
  uiSize = $state<UiSize>(loadUiSize());
  density = $state<Density>(loadDensity());

  apply(): void {
    const r = document.documentElement.style;
    r.setProperty("--ui-font", fontStack(this.uiFont, UI_DEFAULT));
    r.setProperty("--code-font", fontStack(this.codeFont, CODE_DEFAULT));
    r.setProperty("--code-font-size", `${this.codeFontSize}px`);
    const px = UI_SIZE_PX[this.uiSize];
    r.setProperty("--ui-font-size", `${px}px`);
    // Drive the density font tokens (--fs*) so UI size scales *all* component
    // text, not just <body>. Medium (14px) → 1, so the default is unchanged.
    r.setProperty("--ui-scale", String(px / UI_SIZE_PX.medium));
    document.documentElement.dataset.density = this.density;
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
  setCodeFontSize(n: number): void {
    this.codeFontSize = clampCodeSize(n);
    persist(CODE_SIZE_KEY, String(this.codeFontSize));
    this.apply();
  }
  setUiSize(size: UiSize): void {
    this.uiSize = size;
    persist(UI_SIZE_KEY, size);
    this.apply();
  }
  setDensity(density: Density): void {
    this.density = density;
    persist(DENSITY_KEY, density);
    this.apply();
  }
}

export const settings = new Settings();
