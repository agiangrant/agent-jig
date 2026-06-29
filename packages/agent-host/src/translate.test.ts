import { isWriteClass } from "@agent-jig/core";
import { describe, expect, it } from "vitest";
import { geminiToolToJig } from "./translate.ts";

describe("geminiToolToJig", () => {
  it("maps write_file → Write and keeps file_path + content", () => {
    const r = geminiToolToJig({
      kind: "edit",
      rawInput: { file_path: "src/a.ts", content: "hello" },
    });
    expect(r).toEqual({ toolName: "Write", input: { file_path: "src/a.ts", content: "hello" } });
    expect(isWriteClass(r.toolName)).toBe(true);
  });

  it("maps replace → Edit from old_string/new_string", () => {
    const r = geminiToolToJig({
      kind: "edit",
      rawInput: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
    });
    expect(r.toolName).toBe("Edit");
    expect(r.input).toMatchObject({ file_path: "src/a.ts", old_string: "a", new_string: "b" });
    expect(isWriteClass(r.toolName)).toBe(true);
  });

  it("maps run_shell_command → Bash and is not write-class", () => {
    const r = geminiToolToJig({ kind: "execute", rawInput: { command: "ls -la" } });
    expect(r).toEqual({ toolName: "Bash", input: { command: "ls -la" } });
    expect(isWriteClass(r.toolName)).toBe(false);
  });

  it("normalizes absolute_path onto file_path for a write", () => {
    const r = geminiToolToJig({
      kind: "edit",
      rawInput: { absolute_path: "/repo/x.ts", content: "y" },
    });
    expect(r.toolName).toBe("Write");
    expect(r.input.file_path).toBe("/repo/x.ts");
  });

  it("falls back to the edited path from locations when args omit it", () => {
    const r = geminiToolToJig({
      kind: "edit",
      rawInput: { content: "y" },
      locations: [{ path: "src/from-loc.ts" }],
    });
    expect(r.toolName).toBe("Write");
    expect(r.input.file_path).toBe("src/from-loc.ts");
  });

  it("treats read/search/fetch as non-write tools", () => {
    expect(geminiToolToJig({ kind: "read", rawInput: { path: "a.ts" } }).toolName).toBe("Read");
    expect(geminiToolToJig({ kind: "search", rawInput: { pattern: "x" } }).toolName).toBe("Grep");
    expect(geminiToolToJig({ kind: "fetch", rawInput: { url: "u" } }).toolName).toBe("WebFetch");
    for (const k of ["read", "search", "fetch", "think", "other"] as const) {
      expect(isWriteClass(geminiToolToJig({ kind: k, rawInput: {} }).toolName)).toBe(false);
    }
  });

  it("gates an unknown edit-kind tool as a Write so the human still reviews it", () => {
    const r = geminiToolToJig({
      kind: "edit",
      rawInput: { weird: true },
      locations: [{ path: "p" }],
    });
    expect(r.toolName).toBe("Write");
    expect(isWriteClass(r.toolName)).toBe(true);
  });

  it("tolerates a missing/garbage rawInput", () => {
    expect(geminiToolToJig({ kind: null, rawInput: undefined })).toEqual({
      toolName: "Read",
      input: {},
    });
  });
});
