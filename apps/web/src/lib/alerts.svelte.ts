import {
  currentNotificationPermission,
  type NotifyPermission,
  notify,
  requestNotificationPermission,
} from "./platform.ts";

// Attention alerts: when a session needs the human (an edit is queued for review,
// or it's blocked on a question / plan approval) we pull focus back with a flash on
// that session's tab + a notification sound. One toggle gates the whole thing;
// default on, persisted to localStorage. This module owns the toggle, notification
// permission, and the sound; the per-tab flash is owned by App.svelte (it knows
// which session and reads `enabled` before flashing). For the sound we prefer the
// OS notification sound + banner (the Tauri notification plugin on desktop, the web
// Notification API in the browser — see platform.ts); where neither is available
// or permission isn't granted, we fall back to a short in-app WebAudio chime so
// there's always an audible cue.

const ENABLED_KEY = "jig:alerts";

function loadEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== "0"; // on unless explicitly disabled
  } catch {
    return true;
  }
}

/** Short two-tone chime via WebAudio — no asset, no permission. Best-effort: the
 * browser autoplay policy may keep the context suspended until a user gesture. */
function playChime(): void {
  try {
    const Ctx =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    void ctx.resume();
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
    for (const [freq, at] of [
      [880, now],
      [1175, now + 0.12],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, at);
      osc.connect(gain);
      osc.start(at);
      osc.stop(at + 0.5);
    }
    setTimeout(() => void ctx.close(), 800);
  } catch {
    /* audio unavailable */
  }
}

class Alerts {
  /** Master switch for the audible + visual attention alert. */
  enabled = $state<boolean>(loadEnabled());
  /** Reflected in Settings so the user can see/grant notification permission.
   * Resolved asynchronously (the desktop plugin's check is async) via refresh(). */
  permission = $state<NotifyPermission>("default");

  /** Resolve the current permission against the active platform. */
  async refreshPermission(): Promise<void> {
    this.permission = await currentNotificationPermission();
  }

  async setEnabled(value: boolean): Promise<void> {
    this.enabled = value;
    try {
      localStorage.setItem(ENABLED_KEY, value ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
    // Toggling on is a user gesture — the only context where a permission prompt
    // is allowed. Ask now so the OS sound + banner can fire on later alerts.
    if (value) await this.requestPermission();
  }
  toggle(): void {
    void this.setEnabled(!this.enabled);
  }

  /** Request notification permission (call from a click). Updates `permission`. */
  async requestPermission(): Promise<void> {
    this.permission = await requestNotificationPermission();
  }

  /** Play the attention sound — OS notification sound + banner, or an in-app chime
   * where notifications are unsupported or not granted. No-op when alerts are off.
   * The matching tab flash is owned by App.svelte (it knows which session). */
  ping(title: string, body: string): void {
    if (!this.enabled) return;
    void notify(title, body).then((shown) => {
      if (!shown) playChime();
    });
  }
}

export const alerts = new Alerts();
void alerts.refreshPermission(); // reflect the real permission once the platform resolves
