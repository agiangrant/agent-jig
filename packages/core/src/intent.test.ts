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
const directive = (text: string) => ev({ type: "directive", payload: { text } });

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
      {
        id: "a",
        label: "Add a rate-limit guard.",
        editIds: ["a", "b"],
        reason: "Add a rate-limit guard.\nMore detail here.",
      },
      {
        id: "c",
        label: "Wire the guard into the controller.",
        editIds: ["c"],
        reason: "Wire the guard into the controller.",
      },
    ]);
  });

  it("labels edits with a trailing reasoning when none precedes (edit-then-explain)", () => {
    const groups = groupByIntent([
      edit("a"),
      edit("b"),
      reasoning("Renamed the method across all files."),
    ]);
    expect(groups).toEqual([
      {
        id: "a",
        label: "Renamed the method across all files.",
        editIds: ["a", "b"],
        reason: "Renamed the method across all files.",
      },
    ]);
  });

  it("puts edits before any reasoning under 'Other changes'", () => {
    const groups = groupByIntent([edit("a"), reasoning("Now the real work."), edit("b")]);
    expect(groups[0]).toEqual({ id: "a", label: "Other changes", editIds: ["a"], reason: "" });
    expect(groups[1]?.label).toBe("Now the real work.");
  });

  it("ignores reads and non-edit tool calls", () => {
    const groups = groupByIntent([
      reasoning("Explore first."),
      edit("r", "Read"),
      edit("g", "Grep"),
      edit("w", "Write"),
    ]);
    expect(groups).toEqual([
      { id: "w", label: "Explore first.", editIds: ["w"], reason: "Explore first." },
    ]);
  });

  it("drops reasoning that produced no edits", () => {
    const groups = groupByIntent([
      reasoning("Just thinking out loud."),
      reasoning("Actually, edit this."),
      edit("a"),
    ]);
    expect(groups).toEqual([
      { id: "a", label: "Actually, edit this.", editIds: ["a"], reason: "Actually, edit this." },
    ]);
  });

  it("carries the prior intent forward when steering inserts a conversational reply", () => {
    // The original edit was rejected by the steer, so it's gone from the visible
    // stream; the agent's "Noted…" reply must not become the redone edit's label.
    const groups = groupByIntent([
      reasoning("Create CSV adapter foundation for XLSX transformation."),
      directive("Re: your edit — prefer self-documenting code over comments"),
      reasoning("Noted — I'll keep comments minimal across all files."),
      edit("b"),
    ]);
    expect(groups).toEqual([
      {
        id: "b",
        label: "Create CSV adapter foundation for XLSX transformation.",
        editIds: ["b"],
        reason: "Create CSV adapter foundation for XLSX transformation.",
      },
    ]);
  });

  it("condenses a rambling reasoning to a concise first-sentence label with ellipsis", () => {
    const ramble =
      "The setup is clear: NestJS, CommonJS, Node 24 so zlib is available for ZIP work, and Jest specs everywhere across the repo. Lots more detail.";
    const groups = groupByIntent([reasoning(ramble), edit("a")]);
    expect(groups[0]?.label.length).toBeLessThanOrEqual(72);
    expect(groups[0]?.label.endsWith("…")).toBe(true);
    expect(groups[0]?.reason).toBe(ramble); // full text preserved for summarization
  });
});
