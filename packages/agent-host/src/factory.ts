import { type CodexAdapterDeps, codexAdapter } from "./adapters/codex.ts";
import { type GeminiAdapterDeps, geminiAdapter } from "./adapters/gemini.ts";
import type { AgentSDK } from "./agent-sdk.ts";
import { type ClaudeAdapterDeps, claudeAdapter } from "./claude-adapter.ts";

export type AgentProvider = "claude" | "gemini" | "codex";

/** Per-provider construction options for {@link getSDKAdapter}. */
export interface AdapterConfig {
  claude?: ClaudeAdapterDeps;
  gemini?: GeminiAdapterDeps;
  codex?: CodexAdapterDeps;
}

/**
 * Resolve the agent runtime for a session's chosen provider. The governed agent
 * always runs through the {@link AgentSDK} interface, so the rest of the app is
 * provider-agnostic — only this factory knows which adapter to build.
 */
export function getSDKAdapter(provider: AgentProvider, config: AdapterConfig = {}): AgentSDK {
  switch (provider) {
    case "gemini":
      return geminiAdapter(config.gemini);
    case "codex":
      return codexAdapter(config.codex);
    default:
      return claudeAdapter(config.claude);
  }
}
