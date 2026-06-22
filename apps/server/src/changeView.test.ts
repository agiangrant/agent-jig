import type { GateState, JigEvent } from "@agent-jig/contracts";
import { describe, expect, it } from "vitest";
import { buildChangeView } from "./changeView.ts";

let seq = 0;
function ev(partial: Partial<JigEvent> & Pick<JigEvent, "type">): JigEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    sessionId: "s",
    seq,
    ts: seq,
    type: partial.type,
    toolName: partial.toolName ?? null,
    editId: partial.editId ?? null,
    intentGroupId: null,
    risk: null,
    gateState: partial.gateState ?? null,
    payload: partial.payload ?? {},
  };
}

function reasoning(text: string): JigEvent {
  return ev({ type: "reasoning", payload: { text } });
}
function edit(editId: string, path: string): JigEvent {
  return ev({ type: "tool_call", toolName: "Edit", editId, payload: { file_path: path } });
}
function ack(editId: string, gateState: GateState): JigEvent {
  return ev({ type: "ack", editId, gateState });
}

describe("buildChangeView", () => {
  it("groups edits under the preceding reasoning", () => {
    const view = buildChangeView(
      [reasoning("Rename the helper"), edit("a", "src/a.ts"), edit("b", "src/b.ts")],
      null,
    );
    expect(view).toHaveLength(1);
    expect(view[0]?.label).toBe("Rename the helper");
    expect(view[0]?.editIds).toEqual(["a", "b"]);
  });

  it("excludes a rejected edit — it was denied at the gate and never reached disk", () => {
    const view = buildChangeView(
      [
        reasoning("Rename the helper"),
        edit("a", "src/a.ts"),
        edit("b", "src/b.ts"),
        ack("b", "rejected"),
      ],
      null,
    );
    expect(view).toHaveLength(1);
    expect(view[0]?.editIds).toEqual(["a"]);
  });

  it("keeps a released edit", () => {
    const view = buildChangeView(
      [reasoning("Rename the helper"), edit("a", "src/a.ts"), ack("a", "released")],
      null,
    );
    expect(view[0]?.editIds).toEqual(["a"]);
  });

  it("drops a group entirely when its only edit was rejected", () => {
    const view = buildChangeView(
      [reasoning("A risky change"), edit("a", "src/a.ts"), ack("a", "rejected")],
      null,
    );
    expect(view).toEqual([]);
  });
});
