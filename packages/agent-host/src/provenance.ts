import type { OutOfBandChange } from "@governor/contracts";
import { extractPath, isWriteClass } from "@governor/core";
import type { Worktree } from "@governor/worktree";

export type WorktreeLike = Pick<Worktree, "detect">;

/**
 * Flags working-tree changes the agent's gated tools didn't make (Bash writes,
 * the human, formatters). Detection runs only at write-class boundaries and at
 * session end — never after every tool — so git is touched a handful of times
 * per session regardless of repo size or session count.
 */
export class ProvenanceTracker {
  private lastWriteTarget: string | null = null;
  private sawBashSinceCheck = false;

  constructor(private readonly worktree: WorktreeLike) {}

  /**
   * Call for every tool the gate sees. Detects only on write-class tools (the
   * checkpoint); for others it just notes whether a Bash ran, for attribution.
   * Returns the out-of-band changes to record before this tool, if any.
   */
  observe(toolName: string, input: unknown): OutOfBandChange | null {
    if (!isWriteClass(toolName)) {
      if (toolName === "Bash") this.sawBashSinceCheck = true;
      return null;
    }
    const change = this.check();
    this.lastWriteTarget = extractPath(input);
    this.sawBashSinceCheck = false;
    return change;
  }

  /** Reconcile changes made after the final write, at session end. */
  finalize(): OutOfBandChange | null {
    return this.check();
  }

  private check(): OutOfBandChange | null {
    const expected = this.lastWriteTarget === null ? [] : [this.lastWriteTarget];
    const files = this.worktree.detect(expected);
    if (files.length === 0) return null;
    return { attributedTo: this.sawBashSinceCheck ? "bash" : "external", files };
  }
}
