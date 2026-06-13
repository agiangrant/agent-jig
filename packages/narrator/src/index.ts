import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-4-5";
const MAX_CHARS = 1500; // cap before/after to bound tokens

// The register, per spec §6.1: why over what, silent through boilerplate,
// discursive only when something is non-obvious.
const SYSTEM = `You are a pair-programming narrator. Given an agent's reasoning and one code edit, write ONE short sentence explaining WHY the change was made — the intent or tradeoff — not a restatement of what changed (the diff is already on screen).

Rules:
- "Why" over "what". Never describe the syntax; give the reason.
- If the edit is boilerplate or self-evident (imports, formatting, simple renames, obvious wiring), reply with exactly: SILENT
- Be genuinely discursive only when something is non-obvious: an unfamiliar pattern, a tradeoff, or a deviation from how the codebase usually does things.
- One sentence. No preamble, no markdown, no quotes.`;

export interface NarrationInput {
  toolName: string;
  path: string;
  before: string;
  after: string;
  /** The agent's own reasoning nearest this edit, if any. */
  reasoning: string;
}

export interface Narrator {
  /** A one-line "why" for the edit, or null to stay silent. */
  narrate(input: NarrationInput): Promise<string | null>;
}

/** Generates a completion from (system, user). Injectable so the register is testable offline. */
export type GenerateFn = (system: string, user: string) => Promise<string>;

function clip(s: string): string {
  return s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}\n…(truncated)` : s;
}

function buildUserPrompt(input: NarrationInput): string {
  return [
    `Tool: ${input.toolName}`,
    `File: ${input.path}`,
    `Agent reasoning: ${input.reasoning.trim() || "(none captured)"}`,
    "",
    "Before:",
    clip(input.before),
    "",
    "After:",
    clip(input.after),
  ].join("\n");
}

function defaultGenerate(model: string): GenerateFn {
  // Constructed lazily so a missing key fails per-call (caught) rather than at startup.
  let client: Anthropic | null = null;
  return async (system, user) => {
    client ??= new Anthropic();
    const message = await client.messages.create({
      model,
      max_tokens: 120,
      system,
      messages: [{ role: "user", content: user }],
    });
    return message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  };
}

export function createNarrator(opts?: { model?: string; generate?: GenerateFn }): Narrator {
  const generate = opts?.generate ?? defaultGenerate(opts?.model ?? MODEL);
  return {
    async narrate(input) {
      try {
        const text = (await generate(SYSTEM, buildUserPrompt(input))).trim();
        return text.length === 0 || text === "SILENT" ? null : text;
      } catch {
        // Best-effort: a narration failure (no creds, rate limit) is never fatal.
        return null;
      }
    },
  };
}
