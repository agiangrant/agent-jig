import type { DialMode, GateState, PendingEdit } from "@governor/contracts";

/** How a gated tool call resolved. `rejected` carries the developer's reason. */
export interface GateOutcome {
  state: GateState;
  reason?: string;
}

interface Gate {
  edit: PendingEdit;
  resolve: (outcome: GateOutcome) => void;
}

/**
 * The whole backpressure mechanism: an in-memory semaphore. The agent-host calls
 * {@link requestGate} from `canUseTool` per write-class tool; in `slowed` the
 * returned promise blocks until {@link ack} (apply) or {@link reject} (discard +
 * reason → the agent revises). Opening to `realtime` drains the queue (`bypassed`).
 */
export class Pacer {
  private _mode: DialMode;
  private readonly pending = new Map<string, Gate>();

  onQueueChange?: (pending: PendingEdit[]) => void;
  onModeChange?: (mode: DialMode) => void;

  constructor(mode: DialMode = "slowed") {
    this._mode = mode;
  }

  get mode(): DialMode {
    return this._mode;
  }

  /** Pending edits, seq-ordered — the queue timeline. */
  get queue(): PendingEdit[] {
    return [...this.pending.values()].map((g) => g.edit).sort((a, b) => a.seq - b.seq);
  }

  /** True if a write-class edit is currently gated. */
  isPending(editId: string): boolean {
    return this.pending.has(editId);
  }

  /** Resolves to the terminal outcome: open (realtime), released, bypassed, or rejected. */
  requestGate(edit: PendingEdit): Promise<GateOutcome> {
    if (this._mode === "realtime") return Promise.resolve({ state: "open" });
    return new Promise<GateOutcome>((resolve) => {
      this.pending.set(edit.editId, { edit, resolve });
      this.notifyQueue();
    });
  }

  /** Apply a pending edit. False if it was not waiting. */
  ack(editId: string): boolean {
    const gate = this.pending.get(editId);
    if (gate === undefined) return false;
    this.pending.delete(editId);
    gate.resolve({ state: "released" });
    this.notifyQueue();
    return true;
  }

  /** Discard a pending edit and hand the agent a reason to revise. False if not waiting. */
  reject(editId: string, reason: string): boolean {
    const gate = this.pending.get(editId);
    if (gate === undefined) return false;
    this.pending.delete(editId);
    gate.resolve({ state: "rejected", reason });
    this.notifyQueue();
    return true;
  }

  setMode(mode: DialMode): void {
    if (mode === this._mode) return;
    this._mode = mode;
    if (mode === "realtime" && this.pending.size > 0) {
      for (const gate of this.pending.values()) gate.resolve({ state: "bypassed" });
      this.pending.clear();
      this.notifyQueue();
    }
    this.onModeChange?.(mode);
  }

  private notifyQueue(): void {
    this.onQueueChange?.(this.queue);
  }
}
