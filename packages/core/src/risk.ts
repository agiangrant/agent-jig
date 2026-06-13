import type { DialMode, RiskRule } from "@governor/contracts";
import picomatch from "picomatch";

export interface RiskAssessment {
  mode: DialMode;
  risk: number;
  ruleId: string | null;
}

/** Blast-radius default for a path: highest-risk matching rule wins, else the fallback. */
export function scoreRisk(
  path: string,
  rules: readonly RiskRule[],
  fallback: DialMode,
): RiskAssessment {
  const normalized = path.replaceAll("\\", "/");
  let best: RiskRule | null = null;
  for (const rule of rules) {
    if (picomatch.isMatch(normalized, rule.glob) && (best === null || rule.risk > best.risk)) {
      best = rule;
    }
  }
  if (best === null) return { mode: fallback, risk: 0, ruleId: null };
  return { mode: best.defaultMode, risk: best.risk, ruleId: best.id };
}
