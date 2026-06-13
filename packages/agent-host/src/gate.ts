import { randomUUID } from "node:crypto";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { GovernorEvent } from "@governor/contracts";
import { extractPath, isWriteClass, type Pacer, scoreRisk } from "@governor/core";
import type { Storage } from "@governor/store";
import type { ProvenanceTracker } from "./provenance.ts";

export interface GateDeps {
  sessionId: string;
  pacer: Pacer;
  store: Storage;
  /** Fired per appended event so the server can push it to the UI. */
  onEvent?: (event: GovernorEvent) => void;
  /** Detects working-tree changes the agent's gated tools didn't make. */
  tracker?: ProvenanceTracker;
}

/**
 * The SDK `canUseTool` callback — where backpressure is applied. Governor is the
 * permission authority (the human is in the web UI). A write-class tool in
 * `slowed` mode awaits {@link Pacer.requestGate} and genuinely blocks; everything
 * else is logged and allowed at once.
 */
export function makeCanUseTool(deps: GateDeps): CanUseTool {
  const { sessionId, pacer, store, onEvent, tracker } = deps;
  const config = store.getConfig();

  return async (toolName, input) => {
    // Surface anything that changed the working tree since the last write
    // (Bash, the human, a formatter) before this tool's own event.
    const oob = tracker?.observe(toolName, input) ?? null;
    if (oob !== null) {
      const oobEvent = store.appendEvent({
        sessionId,
        type: "out_of_band_change",
        toolName,
        payload: oob,
      });
      onEvent?.(oobEvent);
    }

    const write = isWriteClass(toolName);
    const path = extractPath(input);
    const assessment = path ? scoreRisk(path, config.riskRules, config.defaultMode) : null;
    const risk = assessment?.risk ?? null;
    const editId = write ? randomUUID() : null;
    const willGate = write && pacer.mode === "slowed";

    const call = store.appendEvent({
      sessionId,
      type: "tool_call",
      toolName,
      editId,
      risk,
      gateState: write ? (willGate ? "pending" : "open") : "open",
      payload: input,
    });
    onEvent?.(call);

    if (write && editId !== null) {
      const state = await pacer.requestGate({
        editId,
        toolName,
        path: path ?? "",
        seq: call.seq,
        risk: risk ?? 0,
      });
      // Only record a release when the human actually held it ('open' = realtime passthrough).
      if (state !== "open") {
        const ack = store.appendEvent({
          sessionId,
          type: "ack",
          editId,
          gateState: state,
          payload: {},
        });
        onEvent?.(ack);
      }
    }

    // The SDK validates this result: `updatedInput` must be present (echo the
    // original input back), otherwise the tool is rejected with a ZodError.
    return { behavior: "allow", updatedInput: input };
  };
}
