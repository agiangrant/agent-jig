// Desktop (Tauri) vs browser seam. The same Svelte UI runs in a normal browser
// tab (talking to the Node server over HTTP/WS) and inside the Tauri desktop
// webview. The few genuinely-native concerns branch here: in the browser they
// fall back to the server's HTTP routes; in Tauri they use native IPC plugins.

/** True when running inside the Tauri desktop webview. */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as object);

/**
 * Native folder picker via Tauri's dialog plugin. Dynamically imported so the
 * plugin is code-split out of the browser bundle and only loaded on the desktop.
 * Returns the chosen absolute path, or null if cancelled.
 */
export async function pickFolderNative(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title: "Select a repository" });
  return typeof picked === "string" ? picked : null;
}

/**
 * The font families installed on this machine, via a Rust command (WKWebView /
 * WebView2 lack Chromium's `queryLocalFonts`). Returns [] off the desktop.
 */
export async function listSystemFontsNative(): Promise<string[]> {
  if (!isTauri) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<string[]>("list_system_fonts");
}

/**
 * Best-effort desktop/browser notification — pulls an AFK reviewer back when an
 * edit has been waiting too long. Uses the web Notification API (available in the
 * browser and the Tauri webview); silently no-ops where unsupported or denied.
 */
export async function notify(title: string, body: string): Promise<void> {
  if (typeof Notification === "undefined") return;
  try {
    if (Notification.permission === "default") await Notification.requestPermission();
    if (Notification.permission === "granted") new Notification(title, { body });
  } catch {
    /* notifications unsupported or blocked */
  }
}

const loadedFonts = new Set<string>();

/**
 * Make an installed font usable in the desktop webview. WKWebView won't render
 * arbitrary user-installed fonts via `font-family`, so for any family it can't
 * already render we fetch the font bytes from Rust and register a `FontFace`.
 * No-op in the browser, for system fonts the webview already has, or if loaded.
 */
export async function ensureDesktopFont(family: string): Promise<void> {
  const name = family.trim();
  if (!isTauri || !name || loadedFonts.has(name)) return;
  try {
    // Already renderable (a base system font)? Don't override it.
    if (document.fonts.check(`16px "${name}"`)) {
      loadedFonts.add(name);
      return;
    }
    const { invoke } = await import("@tauri-apps/api/core");
    const bytes = await invoke<ArrayBuffer>("load_font_data", { family: name });
    const face = new FontFace(name, bytes);
    await face.load();
    document.fonts.add(face);
    loadedFonts.add(name);
  } catch {
    /* font unavailable — the CSS fallback stack still applies */
  }
}
