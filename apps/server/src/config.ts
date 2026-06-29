import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { AdapterConfig } from "@agent-jig/agent-host";
import { AgentProvider, type ProviderStatus } from "@agent-jig/contracts";

/**
 * Agent-provider configuration resolved from the environment. Credentials live
 * server-side (never in the browser); the UI only picks a provider + model and
 * reads {@link AgentServerConfig.statuses} to know which providers are ready.
 *
 * Auth mirrors how Claude works — via each CLI's own login (a ChatGPT/Google
 * subscription), with an API key as an alternative. A provider is "ready" when
 * its CLI is installed AND it has either a cached login or an env API key:
 * - Claude runs through the bundled Agent SDK (its own login) — always offered.
 * - Gemini: `gemini login` (→ `~/.gemini/oauth_creds.json`) or `GEMINI_API_KEY`
 *   / `GOOGLE_API_KEY`.
 * - Codex: `codex login` (→ `$CODEX_HOME/auth.json`) or `OPENAI_API_KEY`.
 */
export interface AgentServerConfig {
  /** Pre-selected provider in the New Session modal. */
  defaultProvider: AgentProvider;
  /** Per-provider credentials passed to the adapters. */
  adapterConfig: AdapterConfig;
  /** Readiness of each provider, for the UI. */
  statuses: ProviderStatus[];
}

const LABELS: Record<AgentProvider, string> = {
  claude: "Claude (Anthropic)",
  gemini: "Gemini (Google)",
  codex: "Codex (OpenAI)",
};

/**
 * Suggested models per provider for the picker — the field still takes a custom
 * id. Codex is overridden at runtime from its on-disk model cache; Gemini has no
 * such cache or list command (models are hardcoded in the CLI), so these curated
 * ids are the fallback there.
 */
const MODELS: Record<AgentProvider, string[]> = {
  claude: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
  gemini: [
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-3.1-pro-preview",
    "gemini-3.1-flash-lite",
  ],
  codex: ["gpt-5-codex", "gpt-5"],
};

const fileExists = (p: string): boolean => {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
};

/**
 * A GUI-launched app inherits a minimal PATH, so (on macOS/Linux) ask the user's
 * login shell for its real PATH — the same trick the Tauri shell uses for node —
 * so CLIs installed via nvm/homebrew/npm are found just like in the terminal.
 */
function resolvedPath(env: NodeJS.ProcessEnv): string {
  const base = env.PATH ?? "";
  if (process.platform === "win32") return base;
  try {
    const shell = env.SHELL || "/bin/sh";
    const out = execFileSync(shell, ["-lc", 'printf %s "$PATH"'], {
      encoding: "utf8",
      timeout: 3000,
    });
    return out.trim() ? `${out.trim()}${delimiter}${base}` : base;
  } catch {
    return base;
  }
}

/** Whether `name` resolves to an executable on `path`. */
function commandExists(name: string, path: string): boolean {
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      if (fileExists(join(dir, name + ext))) return true;
    }
  }
  return false;
}

/** True if `$GEMINI_HOME/google_accounts.json` records a signed-in account. */
function geminiAccountActive(geminiHome: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(join(geminiHome, "google_accounts.json"), "utf8"));
    return typeof raw.active === "string" && raw.active.length > 0;
  } catch {
    return false;
  }
}

/** Codex caches its model list to `$CODEX_HOME/models_cache.json` — read its slugs. */
function codexModels(codexHome: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(codexHome, "models_cache.json"), "utf8"));
    const slugs = (raw.models as Array<{ slug?: string }>)
      .map((m) => m.slug)
      .filter((s): s is string => typeof s === "string" && s.length > 0);
    return slugs.length > 0 ? slugs : MODELS.codex;
  } catch {
    return MODELS.codex;
  }
}

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentServerConfig {
  const geminiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || undefined;
  const codexKey = env.OPENAI_API_KEY || undefined;

  const adapterConfig: AdapterConfig = {
    claude: {},
    gemini: geminiKey ? { apiKey: geminiKey } : {},
    codex: codexKey ? { apiKey: codexKey } : {},
  };

  // A cached subscription login (like Claude's) makes a provider usable without
  // an API key — detect each CLI's stored credentials.
  const home = homedir();
  const geminiHome = env.GEMINI_CLI_HOME || join(home, ".gemini");
  // Gemini writes oauth_creds.json on "Login with Google"; google_accounts.json
  // keeps the signed-in email (active=null after logout).
  const geminiLoggedIn =
    fileExists(join(geminiHome, "oauth_creds.json")) || geminiAccountActive(geminiHome);
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  const codexLoggedIn = fileExists(join(codexHome, "auth.json"));

  // Resolve the login-shell PATH for the real process; tests pass a plain env and
  // get a fast PATH-only check (no shell spawn).
  const path = env === process.env ? resolvedPath(env) : (env.PATH ?? "");

  const available: Record<AgentProvider, boolean> = {
    claude: true, // governed via the bundled Agent SDK's own login
    gemini: (Boolean(geminiKey) || geminiLoggedIn) && commandExists("gemini", path),
    codex: (Boolean(codexKey) || codexLoggedIn) && commandExists("codex", path),
  };

  // A requested default that isn't available falls back to Claude.
  const requested = AgentProvider.safeParse(env.AGENT_SDK_DEFAULT);
  const defaultProvider =
    requested.success && available[requested.data] ? requested.data : "claude";

  const models: Record<AgentProvider, string[]> = {
    claude: MODELS.claude,
    gemini: MODELS.gemini,
    codex: codexModels(codexHome),
  };

  const statuses: ProviderStatus[] = AgentProvider.options.map((id) => ({
    id,
    label: LABELS[id],
    available: available[id],
    models: models[id],
  }));

  return { defaultProvider, adapterConfig, statuses };
}
