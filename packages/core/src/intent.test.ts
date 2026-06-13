import type { GovernorEvent } from "@governor/contracts";
import { describe, expect, it } from "vitest";
import { groupByIntent } from "./intent.ts";

let seq = 0;
function ev(partial: Partial<GovernorEvent>): GovernorEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    sessionId: "s",
    seq,
    ts: 0,
    type: "tool_call",
    toolName: null,
    editId: null,
    intentGroupId: null,
    risk: null,
    gateState: null,
    payload: null,
    ...partial,
  };
}

const reasoning = (text: string) => ev({ type: "reasoning", payload: { text } });
const edit = (editId: string, toolName = "Edit") => ev({ type: "tool_call", toolName, editId });

describe("groupByIntent", () => {
  it("labels edits with the reasoning that precedes them", () => {
    const groups = groupByIntent([
      reasoning("Add a rate-limit guard.\nMore detail here."),
      edit("a", "Write"),
      edit("b"),
      reasoning("Wire the guard into the controller."),
      edit("c"),
    ]);
    expect(groups).toEqual([
      { id: "a", label: "Add a rate-limit guard.", editIds: ["a", "b"] },
      { id: "c", label: "Wire the guard into the controller.", editIds: ["c"] },
    ]);
  });

  it("labels edits with a trailing reasoning when none precedes (edit-then-explain)", () => {
    const groups = groupByIntent([
      edit("a"),
      edit("b"),
      reasoning("Renamed the method across all files."),
    ]);
    expect(groups).toEqual([
      { id: "a", label: "Renamed the method across all files.", editIds: ["a", "b"] },
    ]);
  });

  it("puts edits before any reasoning under 'Other changes'", () => {
    const groups = groupByIntent([edit("a"), reasoning("Now the real work."), edit("b")]);
    expect(groups[0]).toEqual({ id: "a", label: "Other changes", editIds: ["a"] });
    expect(groups[1]?.label).toBe("Now the real work.");
  });

  it("ignores reads and non-edit tool calls", () => {
    const groups = groupByIntent([
      reasoning("Explore first."),
      edit("r", "Read"),
      edit("g", "Grep"),
      edit("w", "Write"),
    ]);
    expect(groups).toEqual([{ id: "w", label: "Explore first.", editIds: ["w"] }]);
  });

  it("drops reasoning that produced no edits", () => {
    const groups = groupByIntent([
      reasoning("Just thinking out loud."),
      reasoning("Actually, edit this."),
      edit("a"),
    ]);
    expect(groups).toEqual([{ id: "a", label: "Actually, edit this.", editIds: ["a"] }]);
  });
});
