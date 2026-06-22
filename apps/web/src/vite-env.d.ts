/// <reference types="svelte" />
/// <reference types="vite/client" />

interface Window {
  /** Injected by the Tauri desktop host: the live sidecar WebSocket base URL. */
  __JIG_WS_URL__?: string;
}
