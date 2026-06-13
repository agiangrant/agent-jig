import type { DialMode, GateState, PendingEdit } from "@governor/contracts";

interface Gate {
  edit: PendingEdit;
  resolve: (state: GateState) => void;
}

/**
 * The whole backpressure mechanism: an in-memory semaphore. The agent-host
 * calls {@link requestGate} from `canUseTool` per write-class tool; in `slowed`
 * the returned promise blocks until {@link ack}. Opening to `realtime` drains
 * the queue at once (`bypassed`).
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

  /** Resolves to the terminal state: `open` (realtime), `released` (acked), or `bypassed`. */
  requestGate(edit: PendingEdit): Promise<GateState> {
    if (this._mode === "realtime") return Promise.resolve("open");
    return new Promise<GateState>((resolve) => {
      this.pending.set(edit.editId, { edit, resolve });
      this.notifyQueue();
    });
  }

  /** Release one pending edit. False if it was not waiting. */
  ack(editId: string): boolean {
    const gate = this.pending.get(editId);
    if (gate === undefined) return false;
    this.pending.delete(editId);
    gate.resolve("released");
    this.notifyQueue();
    return true;
  }

  setMode(mode: DialMode): void {
    if (mode === this._mode) return;
    this._mode = mode;
    if (mode === "realtime" && this.pending.size > 0) {
      for (const gate of this.pending.values()) gate.resolve("bypassed");
      this.pending.clear();
      this.notifyQueue();
    }
    this.onModeChange?.(mode);
  }

  private notifyQueue(): void {
    this.onQueueChange?.(this.queue);
  }
}
