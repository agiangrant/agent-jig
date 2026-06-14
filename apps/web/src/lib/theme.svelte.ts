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
  const set = (cssVar: string, ...candidates: (string | undefined)[]) => {
    const val = candidates.find((v) => typeof v === "string" && v.length > 0);
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
  set("--accent", c.focusBorder, c["button.background"], c["textLink.foreground"]);
  set("--muted", c.descriptionForeground, c["editorLineNumber.foreground"]);
  set("--ok", c["gitDecoration.addedResourceForeground"], c["editorGutter.addedBackground"]);
  set("--warn", c["editorWarning.foreground"], c["list.warningForeground"]);
  set("--danger", c["editorError.foreground"], c["gitDecoration.deletedResourceForeground"]);
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
