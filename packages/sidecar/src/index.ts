import { InputStream } from "@agent-jig/agent-host";
import { query } from "@anthropic-ai/claude-agent-sdk";

const SIDECAR_SYSTEM = `You are the Jig sidecar — a read-only assistant beside a developer who is supervising an AI coding agent. The developer asks you about what the agent is doing and why.

You have read-only tools (Read, Grep, Glob) over the working repository, and each question includes a transcript of the agent's recent reasoning and edits.

Your job:
- Answer PROVENANCE questions from evidence: where did a value, list, or decision come from? Cite the transcript, or the file and location you found it in.
- Be HONEST about provenance. If the transcript shows the agent's actual reasoning, say so. If it does NOT, say plainly that the transcript doesn't show why, and offer: "want me to ask the agent directly?" Never invent a rationale the agent never stated.
- You do NOT change code and you do NOT steer the agent. You are a thinking partner. If the developer concludes the agent should change course, tell them they can send a directive from the steer box — you won't do it for them.
- Be concise and concrete. Prefer file:line and short quotes over paraphrase.`;

export interface SidecarOptions {
  repoPath: string;
  model?: string;
  /** Injectable for tests; defaults to the real SDK `query`. */
  queryImpl?: typeof query;
}

/**
 * A conversational interlocutor: a separate, read-only Agent SDK session the
 * human talks to without disturbing the main agent. It answers provenance
 * questions from the transcript (passed per question) and the repo (via its
 * read tools), is honest when the why isn't recorded, and never steers — that
 * stays the human's trigger (the directive channel).
 */
export class Sidecar {
  private readonly input = new InputStream();
  private readonly runner: ReturnType<typeof query>;
  private readonly pending: Array<(reply: string) => void> = [];
  private buffer = "";

  constructor(opts: SidecarOptions) {
    this.runner = (opts.queryImpl ?? query)({
      prompt: this.input,
      options: {
        cwd: opts.repoPath,
        systemPrompt: SIDECAR_SYSTEM,
        allowedTools: ["Read", "Grep", "Glob"],
        model: opts.model ?? "claude-haiku-4-5",
      },
    });
    void this.consume();
  }

  /** Ask a question (the caller includes any transcript context). Resolves with the reply. */
  ask(text: string): Promise<string> {
    return new Promise((resolve) => {
      this.pending.push(resolve);
      this.input.push(text);
    });
  }

  async close(): Promise<void> {
    this.input.end();
    await this.runner.interrupt().catch(() => {});
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.runner) {
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text") this.buffer += block.text;
          }
        } else if (message.type === "result") {
          this.pending.shift()?.(this.buffer.trim());
          this.buffer = "";
        }
      }
    } catch {
      // fall through to drain pending below
    }
    for (const resolve of this.pending.splice(0)) resolve("");
  }
}
