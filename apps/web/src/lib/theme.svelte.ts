import { BUILTIN_THEMES, getHighlighter } from "./highlight.ts";

const CURRENT_KEY = "governor:theme";
const CUSTOM_KEY = "governor:customThemes";
const DEFAULT_THEME = "one-dark-pro";

/** A VSCode-style theme JSON (only the bits we need are typed). */
interface VsTheme {
  name?: string;
  type?: "light" | "dark";
  colors?: Record<string, string>;
  [k: string]: unknown;
}

function loadCustom(): VsTheme[] {
  try {
    const v = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? "[]");
    return Array.isArray(v) ? (v as VsTheme[]) : [];
  } catch {
    return [];
  }
}
function loadCurrent(): string {
  try {
    return localStorage.getItem(CURRENT_KEY) || DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** Parse a hex (#rgb/#rrggbb/#rrggbbaa) or rgb()/rgba() color to [r,g,b], or null. */
function parseColor(color: string): [number, number, number] | null {
  let s = color.trim();
  if (s.startsWith("#")) {
    s = s.slice(1);
    if (s.length === 3) s = [...s].map((ch) => ch + ch).join("");
    if (s.length === 8) s = s.slice(0, 6);
    if (s.length !== 6) return null;
    const n = Number.parseInt(s, 16);
    return Number.isNaN(n) ? null : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m?.[1]) {
    const [r, g, b] = m[1].split(",").map((p) => Number.parseFloat(p));
    if (r !== undefined && g !== undefined && b !== undefined) return [r, g, b];
  }
  return null;
}

/** A usable solid color: present, parseable, and not (near-)transparent. */
function isVisible(color: string | undefined): color is string {
  if (!color) return false;
  const s = color.trim().toLowerCase();
  if (s === "transparent") return false;
  if (/^#[0-9a-f]{6}00$/.test(s) || /^#[0-9a-f]{3}0$/.test(s)) return false; // alpha 00
  if (/rgba?\([^)]*,\s*0(\.0+)?\)$/.test(s)) return false; // rgba(…, 0)
  return parseColor(s) !== null;
}

/** Black or white, whichever reads on `color` — so colored buttons are legible. */
function contrastText(color: string): string {
  const rgb = parseColor(color);
  if (!rgb) return "#0c0d12";
  const [r, g, b] = rgb.map((v) => v / 255);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.55 ? "#0c0d12" : "#ffffff";
}

/**
 * Map a resolved theme's VSCode `colors` onto the UI's chrome CSS variables, so
 * the whole app (not just code) follows the selected theme. Missing keys keep
 * the stylesheet defaults.
 */
async function applyChrome(name: string): Promise<void> {
  const hl = await getHighlighter();
  let theme: { colors?: Record<string, string>; fg?: string; bg?: string; type?: string };
  try {
    theme = hl.getTheme(name);
  } catch {
    return;
  }
  const c = theme.colors ?? {};
  const root = document.documentElement.style;
  const pick = (...candidates: (string | undefined)[]): string | undefined =>
    candidates.find((v) => typeof v === "string" && v.length > 0);
  const set = (cssVar: string, ...candidates: (string | undefined)[]) => {
    const val = pick(...candidates);
    if (val) root.setProperty(cssVar, val);
  };
  set("--bg", c["editor.background"], theme.bg);
  set("--fg", c["editor.foreground"], theme.fg);
  set(
    "--panel",
    c["sideBar.background"],
    c["editorWidget.background"],
    c["editor.background"],
    theme.bg,
  );
  set("--line", c["panel.border"], c["editorGroup.border"], c["input.border"], c.contrastBorder);
  set("--muted", c.descriptionForeground, c["editorLineNumber.foreground"]);
  set("--ok", c["gitDecoration.addedResourceForeground"], c["editorGutter.addedBackground"]);
  set("--danger", c["editorError.foreground"], c["gitDecoration.deletedResourceForeground"]);

  // Accent/warn back filled buttons & badges (and color accent text/links), so
  // prefer a saturated, visible source. `focusBorder` is a poor accent on many
  // light themes (transparent or near-white), so it's the last resort. Derive a
  // readable text color from each so no theme renders black-on-black/white-on-white.
  const accent = [c["textLink.foreground"], c["button.background"], c.focusBorder].find(isVisible);
  if (accent) {
    root.setProperty("--accent", accent);
    root.setProperty("--on-accent", contrastText(accent));
  }
  const warn = [c["editorWarning.foreground"], c["list.warningForeground"]].find(isVisible);
  if (warn) {
    root.setProperty("--warn", warn);
    root.setProperty("--on-warn", contrastText(warn));
  }
  set(
    "--diff-add-bg",
    c["diffEditor.insertedLineBackground"],
    c["diffEditor.insertedTextBackground"],
    "rgba(127, 209, 127, 0.12)",
  );
  set(
    "--diff-del-bg",
    c["diffEditor.removedLineBackground"],
    c["diffEditor.removedTextBackground"],
    "rgba(224, 108, 117, 0.12)",
  );
  root.setProperty("color-scheme", theme.type === "light" ? "light" : "dark");
}

/** Reactive theme selection shared across the app. */
class ThemeState {
  current = $state<string>(loadCurrent());
  /** All selectable theme names: presets + imported custom ones. */
  available = $state<string[]>([...BUILTIN_THEMES]);

  /** Load any custom themes into the highlighter and apply the saved selection. */
  async init(): Promise<void> {
    const hl = await getHighlighter();
    for (const t of loadCustom()) {
      if (!t.name) continue;
      try {
        await hl.loadTheme(t as Parameters<typeof hl.loadTheme>[0]);
        if (!this.available.includes(t.name)) this.available = [...this.available, t.name];
      } catch {
        /* skip a malformed custom theme */
      }
    }
    // If the saved theme didn't load (e.g. removed), fall back to the default.
    if (!this.available.includes(this.current)) this.current = DEFAULT_THEME;
    await applyChrome(this.current);
  }

  select(name: string): void {
    this.current = name;
    try {
      localStorage.setItem(CURRENT_KEY, name);
    } catch {
      /* storage unavailable */
    }
    void applyChrome(name);
  }

  /** Apply a theme live without persisting — for hover/preview in the palette. */
  preview(name: string): void {
    this.current = name;
    void applyChrome(name);
  }

  /** Import a VSCode theme JSON string; selects it on success. Returns its name. */
  async importTheme(json: string): Promise<string> {
    const parsed = JSON.parse(json) as VsTheme;
    if (!parsed.name) throw new Error('theme JSON has no "name"');
    const hl = await getHighlighter();
    await hl.loadTheme(parsed as Parameters<typeof hl.loadTheme>[0]);
    const custom = loadCustom().filter((t) => t.name !== parsed.name);
    custom.push(parsed);
    try {
      localStorage.setItem(CUSTOM_KEY, JSON.stringify(custom));
    } catch {
      /* storage unavailable */
    }
    if (!this.available.includes(parsed.name)) this.available = [...this.available, parsed.name];
    this.select(parsed.name);
    return parsed.name;
  }
}

export const theme = new ThemeState();
