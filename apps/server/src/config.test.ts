import { describe, expect, it } from "vitest";
import { loadAgentConfig } from "./config.ts";

describe("loadAgentConfig", () => {
  it("always offers Claude and defaults to it", () => {
    const cfg = loadAgentConfig({} as NodeJS.ProcessEnv);
    expect(cfg.defaultProvider).toBe("claude");
    expect(cfg.statuses.find((s) => s.id === "claude")?.available).toBe(true);
  });

  it("threads API keys into the adapter config", () => {
    const cfg = loadAgentConfig({
      GEMINI_API_KEY: "g-key",
      OPENAI_API_KEY: "o-key",
    } as NodeJS.ProcessEnv);
    expect(cfg.adapterConfig.gemini?.apiKey).toBe("g-key");
    expect(cfg.adapterConfig.codex?.apiKey).toBe("o-key");
  });

  it("accepts GOOGLE_API_KEY as the Gemini key", () => {
    const cfg = loadAgentConfig({ GOOGLE_API_KEY: "g-key" } as NodeJS.ProcessEnv);
    expect(cfg.adapterConfig.gemini?.apiKey).toBe("g-key");
  });

  it("falls back to Claude when the requested default provider isn't available", () => {
    // gemini isn't installed in the test env, so it can't be the default.
    const cfg = loadAgentConfig({ AGENT_SDK_DEFAULT: "gemini" } as NodeJS.ProcessEnv);
    expect(cfg.defaultProvider).toBe("claude");
  });

  it("reports a status for every provider", () => {
    const cfg = loadAgentConfig({} as NodeJS.ProcessEnv);
    expect(cfg.statuses.map((s) => s.id).sort()).toEqual(["claude", "codex", "gemini"]);
  });
});
