import { DEFAULT_CONFIG } from "@agent-jig/contracts";
import { describe, expect, it } from "vitest";
import { scoreRisk } from "./risk.ts";

const rules = DEFAULT_CONFIG.riskRules;

describe("scoreRisk", () => {
  it("downshifts high-risk paths to slowed", () => {
    expect(scoreRisk("src/auth/login.ts", rules, "realtime").mode).toBe("slowed");
    expect(scoreRisk("db/migrations/001_init.sql", rules, "realtime").mode).toBe("slowed");
  });

  it("keeps tests and docs near realtime", () => {
    expect(scoreRisk("src/foo.test.ts", rules, "slowed").mode).toBe("realtime");
    expect(scoreRisk("README.md", rules, "slowed").mode).toBe("realtime");
  });

  it("falls back to the session default when nothing matches", () => {
    const result = scoreRisk("src/util/format.ts", rules, "slowed");
    expect(result).toEqual({ mode: "slowed", risk: 0, ruleId: null });
  });

  it("picks the most conservative rule when several match", () => {
    const overlapping = [
      { id: "low", glob: "src/**", defaultMode: "realtime" as const, risk: 0.2 },
      { id: "high", glob: "**/billing/**", defaultMode: "slowed" as const, risk: 0.95 },
    ];
    const result = scoreRisk("src/billing/charge.ts", overlapping, "realtime");
    expect(result.ruleId).toBe("high");
    expect(result.mode).toBe("slowed");
  });

  it("normalises windows-style separators", () => {
    expect(scoreRisk("src\\auth\\login.ts", rules, "realtime").mode).toBe("slowed");
  });
});
