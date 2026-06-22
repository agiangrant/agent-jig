const MODE_KEY = "jig:diffMode";
const LINES_KEY = "jig:lineNumbers";

export type DiffViewMode = "split" | "unified" | "ba";

function load(): DiffViewMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === "unified" || v === "ba" || v === "split" ? v : "split";
  } catch {
    return "split";
  }
}
function loadLines(): boolean {
  try {
    return localStorage.getItem(LINES_KEY) !== "0"; // on by default
  } catch {
    return true;
  }
}

/** The developer's chosen code-view options, shared across views and persisted. */
class DiffModeState {
  mode = $state<DiffViewMode>(load());
  /** Which side the before/after view shows. */
  side = $state<"before" | "after">("after");
  /** Show line numbers in code/diff views. */
  lineNumbers = $state<boolean>(loadLines());

  set(mode: DiffViewMode): void {
    this.mode = mode;
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* storage unavailable */
    }
  }

  toggleLineNumbers(): void {
    this.lineNumbers = !this.lineNumbers;
    try {
      localStorage.setItem(LINES_KEY, this.lineNumbers ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  }
}

export const diffMode = new DiffModeState();
