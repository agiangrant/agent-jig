/**
 * A minimal single-consumer async queue: push values, end the stream, iterate.
 * Used by the subprocess adapters to turn callback-driven protocol events into
 * an {@link AsyncIterable} of normalized messages, and to feed steering prompts
 * into the run loop. (The Claude adapter has its own {@link InputStream}, which
 * is the same idea specialized to the SDK's user-message wire shape.)
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | null = null;
  private ended = false;

  push(value: T): void {
    if (this.ended) return;
    if (this.waiting) {
      this.waiting({ value, done: false });
      this.waiting = null;
    } else {
      this.queue.push(value);
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.waiting) {
      this.waiting({ value: undefined as unknown as T, done: true });
      this.waiting = null;
    }
  }

  /** True when nothing is queued — used to decide when a run can wind down. */
  get idle(): boolean {
    return this.queue.length === 0;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const queued = this.queue.shift();
      if (queued !== undefined) {
        yield queued;
        continue;
      }
      if (this.ended) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiting = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }
}
