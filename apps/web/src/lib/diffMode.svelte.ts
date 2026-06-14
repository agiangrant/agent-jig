const MODE_KEY = "governor:diffMode";

export type DiffViewMode = "split" | "unified" | "ba";

function load(): DiffViewMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === "unified" || v === "ba" || v === "split" ? v : "split";
  } catch {
    return "split";
  }
}

/** The developer's chosen edit-diff layout, shared across views and persisted. */
class DiffModeState {
  mode = $state<DiffViewMode>(load());
  /** Which side the before/after view shows. */
  side = $state<"before" | "after">("after");

  set(mode: DiffViewMode): void {
    this.mode = mode;
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* storage unavailable */
    }
  }
}

export const diffMode = new DiffModeState();
