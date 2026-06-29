import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { AdapterConfig } from "@agent-jig/agent-host";
import { AgentProvider, type ProviderStatus } from "@agent-jig/contracts";

/**
 * Agent-provider configuration resolved from the environment. Credentials live
 * server-side (never in the browser); the UI only picks a provider + model and
 * reads {@link AgentServerConfig.statuses} to know which providers are present.
 *
 * "Available" means the CLI is installed (its binary is on the resolved PATH),
 * mirroring how Claude is always offered via its bundled SDK. We deliberately do
 * NOT gate on detecting a login file — auth lives in many places (env key, OAuth
 * file, OS keychain), so a missing file is a poor signal; an unauthenticated CLI
 * surfaces its own error at run time instead. API keys, when set, are still
 * passed to the adapters.
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

const SENTINEL = "__JIG_PATH__";
/** Memoized once per process — the login shell is spawned at most once. */
let cachedPath: string | undefined;

/**
 * A GUI-launched app inherits a minimal PATH, so on macOS/Linux ask the user's
 * shell for its real PATH. We try an **interactive** login shell first (`-ilc`)
 * because PATH additions from nvm/npm/Homebrew usually live in `.zshrc`/`.bashrc`
 * (interactive rc files), which a plain login shell wouldn't source. A sentinel
 * around the value lets us ignore any banner output rc files print. Called only
 * with the real `process.env`, so the result is memoized for the process.
 */
function resolvedPath(env: NodeJS.ProcessEnv): string {
  const base = env.PATH ?? "";
  // No shell probe under Windows or tests (vitest sets VITEST).
  if (process.platform === "win32" || env.VITEST) return base;
  if (cachedPath !== undefined) return cachedPath;
  const shell = env.SHELL || "/bin/zsh";
  cachedPath = base;
  for (const flags of [["-ilc"], ["-lc"]]) {
    try {
      const out = execFileSync(shell, [...flags, `printf '${SENTINEL}%s' "$PATH"`], {
        encoding: "utf8",
        timeout: 4000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const i = out.lastIndexOf(SENTINEL);
      const p = i >= 0 ? out.slice(i + SENTINEL.length).trim() : "";
      if (p) {
        cachedPath = `${p}${delimiter}${base}`;
        break;
      }
    } catch {
      // try the next shell invocation, then fall back to the inherited PATH
    }
  }
  return cachedPath;
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

/**
 * Detect which providers are installed and their model suggestions — recomputed
 * fresh (not cached at boot), so a CLI installed after start-up appears without a
 * restart. Tests pass a plain env and get a fast PATH-only check (no shell spawn).
 */
export function providerStatuses(env: NodeJS.ProcessEnv = process.env): {
  statuses: ProviderStatus[];
  defaultProvider: AgentProvider;
} {
  const path = env === process.env ? resolvedPath(env) : (env.PATH ?? "");
  const available: Record<AgentProvider, boolean> = {
    claude: true, // always offered via the bundled Agent SDK
    gemini: commandExists("gemini", path),
    codex: commandExists("codex", path),
  };
  const codexHome = env.CODEX_HOME || join(homedir(), ".codex");
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
  const requested = AgentProvider.safeParse(env.AGENT_SDK_DEFAULT);
  const defaultProvider =
    requested.success && available[requested.data] ? requested.data : "claude";
  return { statuses, defaultProvider };
}

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentServerConfig {
  const geminiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || undefined;
  const codexKey = env.OPENAI_API_KEY || undefined;

  const adapterConfig: AdapterConfig = {
    claude: {},
    gemini: geminiKey ? { apiKey: geminiKey } : {},
    codex: codexKey ? { apiKey: codexKey } : {},
  };

  const { statuses, defaultProvider } = providerStatuses(env);
  return { defaultProvider, adapterConfig, statuses };
}
