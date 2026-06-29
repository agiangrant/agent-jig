import { isWriteClass } from "@agent-jig/core";
import type { AgentSDK, GateDecision } from "./agent-sdk.ts";

/**
 * Run an adapter as a read-only, single-turn helper and return its text. The
 * gate denies write-class tools (so it can read/search/inspect but never edits)
 * — a provider-agnostic way to get a "read-only" agent without per-provider
 * sandbox flags. Used by the reviewer and second-opinion sidecar.
 */
export async function runReadOnly(
  adapter: AgentSDK,
  opts: { prompt: string; cwd: string; appendSystemPrompt?: string },
): Promise<string> {
  const gate = async (toolName: string, input: Record<string, unknown>): Promise<GateDecision> =>
    isWriteClass(toolName)
      ? { allow: false, message: "This is a read-only review; do not edit files." }
      : { allow: true, updatedInput: input };

  const run = adapter.run({
    prompt: opts.prompt,
    cwd: opts.cwd,
    gate,
    appendSystemPrompt: opts.appendSystemPrompt,
  });

  let text = "";
  for await (const message of run) {
    if (message.type === "reasoning") text += `${message.text}\n`;
    else if (message.type === "result") run.end(); // one turn is enough
  }
  return text.trim();
}
