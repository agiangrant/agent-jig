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

// Notifications branch like the other native concerns: the desktop shell uses the
// Tauri notification plugin (the web Notification API is absent in WKWebView),
// while the browser uses the web Notification API. Both deliver the OS notification
// banner + sound. The plugin is dynamically imported so it's code-split out of the
// browser bundle (same pattern as pickFolderNative).

/** "unsupported" where no notification mechanism is available. */
export type NotifyPermission = "granted" | "denied" | "default" | "unsupported";

/** Current notification permission, resolved against the active platform. */
export async function currentNotificationPermission(): Promise<NotifyPermission> {
  if (isTauri) {
    try {
      const { isPermissionGranted } = await import("@tauri-apps/plugin-notification");
      return (await isPermissionGranted()) ? "granted" : "default";
    } catch {
      return "unsupported";
    }
  }
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/**
 * Ask the OS for notification permission. MUST be called from a user gesture (a
 * click) — Safari/WKWebView reject a request from a timer or effect. Returns the
 * resulting permission (or "unsupported").
 */
export async function requestNotificationPermission(): Promise<NotifyPermission> {
  if (isTauri) {
    try {
      const { isPermissionGranted, requestPermission } = await import(
        "@tauri-apps/plugin-notification"
      );
      if (await isPermissionGranted()) return "granted";
      return (await requestPermission()) as NotifyPermission;
    } catch {
      return "unsupported";
    }
  }
  if (typeof Notification === "undefined") return "unsupported";
  try {
    if (Notification.permission === "default") return await Notification.requestPermission();
    return Notification.permission;
  } catch {
    return Notification.permission;
  }
}

/**
 * Best-effort OS notification — pulls an AFK reviewer back. Showing it also plays
 * the OS notification sound. Returns true when a notification was actually shown,
 * so callers can fall back to an in-app sound where it's unsupported or not
 * granted. Does NOT request permission — do that from a user gesture via
 * requestNotificationPermission().
 */
export async function notify(title: string, body: string): Promise<boolean> {
  if (isTauri) {
    try {
      const { isPermissionGranted, sendNotification } = await import(
        "@tauri-apps/plugin-notification"
      );
      if (await isPermissionGranted()) {
        sendNotification({ title, body });
        return true;
      }
    } catch {
      /* plugin unavailable */
    }
    return false;
  }
  if (typeof Notification === "undefined") return false;
  try {
    if (Notification.permission === "granted") {
      new Notification(title, { body });
      return true;
    }
  } catch {
    /* notifications unsupported or blocked */
  }
  return false;
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
