import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * A controllable async-iterable of user messages feeding the SDK session — the
 * inbound steering channel. The initial task is pushed first; directives pushed
 * later are delivered to the agent at the next tool-call boundary. `end()` closes
 * the stream so the session can complete.
 */
export class InputStream implements AsyncIterable<SDKUserMessage> {
  private readonly queue: SDKUserMessage[] = [];
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  private ended = false;

  push(text: string): void {
    if (this.ended) return;
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    };
    if (this.waiting) {
      this.waiting({ value: msg, done: false });
      this.waiting = null;
    } else {
      this.queue.push(msg);
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.waiting) {
      this.waiting({ value: undefined as unknown as SDKUserMessage, done: true });
      this.waiting = null;
    }
  }

  /** True when nothing is queued — used to auto-end after the agent's final turn. */
  get idle(): boolean {
    return this.queue.length === 0;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      const queued = this.queue.shift();
      if (queued !== undefined) {
        yield queued;
        continue;
      }
      if (this.ended) return;
      const next = await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        this.waiting = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }
}
