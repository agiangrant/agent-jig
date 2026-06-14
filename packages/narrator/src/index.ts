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

// Labels a group of edits with the developer's intent — a scannable changelog line.
const INTENT_SYSTEM = `You label a group of code edits with the developer's intent, for an at-a-glance change log. Given the agent's reasoning, reply with a SHORT imperative phrase (max 8 words) naming what this step accomplishes — like a good commit summary.

Rules:
- Imperative mood: "Add ZIP export", "Wire xlsx parser into the import service".
- Name the concrete thing being changed; avoid vague words like "update" or "improve".
- No trailing period, no quotes, no markdown, no preamble — just the phrase.`;

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
  /** A short imperative intent label for a group's reasoning, or null. */
  summarize(reasoning: string): Promise<string | null>;
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

function anthropicGenerate(model: string): GenerateFn {
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

/**
 * Any OpenAI-compatible chat endpoint (Ollama, LM Studio, vLLM, OpenAI, …) via
 * plain fetch — no SDK dep. The key is optional (Ollama needs none).
 */
function openAiGenerate(baseUrl: string, model: string, apiKey?: string): GenerateFn {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  return async (system, user) => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        max_tokens: 120,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`LLM endpoint returned ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  };
}

/**
 * Pick the generator from the environment. With `GOVERNOR_LLM_BASE_URL` set we
 * talk to any OpenAI-compatible endpoint (point it at a local Ollama, say);
 * otherwise we use the Anthropic SDK with Haiku.
 */
function defaultGenerate(model: string): GenerateFn {
  const baseUrl = process.env.GOVERNOR_LLM_BASE_URL;
  if (baseUrl) {
    return openAiGenerate(
      baseUrl,
      process.env.GOVERNOR_LLM_MODEL ?? model,
      process.env.GOVERNOR_LLM_API_KEY,
    );
  }
  return anthropicGenerate(model);
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
    async summarize(reasoning) {
      const r = reasoning.trim();
      if (r.length === 0) return null;
      try {
        const text = (await generate(INTENT_SYSTEM, clip(r)))
          .trim()
          .replace(/^["']|["']$/g, "")
          .replace(/\.$/, "");
        return text.length === 0 ? null : text.slice(0, 80);
      } catch {
        return null;
      }
    },
  };
}
