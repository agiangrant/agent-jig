/**
 * Provider tool → Jig tool vocabulary. Jig's gate, line-number enrichment, diff
 * view, and narration all key off Claude's tool names and input shapes
 * (`Write {file_path, content}`, `Edit {file_path, old_string, new_string}`,
 * `Bash {command}`, …). Each non-Claude adapter translates its CLI's tool calls
 * into that shape *here*, so the rest of the app stays provider-agnostic.
 *
 * These are pure functions — the high-value, easily-tested seam of an adapter.
 */

export interface JigToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

/** ACP tool-call categories (the Gemini CLI reports one of these per tool). */
export type AcpToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export interface AcpToolInfo {
  kind?: AcpToolKind | null;
  rawInput?: unknown;
  /** File locations the tool touches; used as a fallback for the edited path. */
  locations?: ReadonlyArray<{ path: string }> | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? { ...(value as Record<string, unknown>) } : {};
}

/**
 * Map a Gemini-CLI (ACP) tool call onto Jig's tool vocabulary. ACP exposes the
 * tool's *category* (`kind`) and raw arguments (`rawInput`) but not the literal
 * tool name, so we infer from the argument shape first (most reliable) and fall
 * back to `kind`. The edited path is normalized onto `file_path` because that is
 * the key the gate reads for risk scoring and real line numbers.
 */
export function geminiToolToJig(info: AcpToolInfo): JigToolCall {
  const input = asRecord(info.rawInput);

  // Gemini uses absolute_path / dir_path in places; the gate expects file_path.
  const path =
    (typeof input.file_path === "string" && input.file_path) ||
    (typeof input.absolute_path === "string" && input.absolute_path) ||
    (typeof input.path === "string" && input.path) ||
    (typeof input.dir_path === "string" && input.dir_path) ||
    info.locations?.[0]?.path ||
    "";
  if (path && typeof input.file_path !== "string") input.file_path = path;

  // Shape-based inference (most reliable) — independent of `kind`.
  if (typeof input.command === "string") return { toolName: "Bash", input };
  if (typeof input.old_string === "string" || typeof input.new_string === "string") {
    return { toolName: "Edit", input };
  }
  if (typeof input.content === "string" && path) return { toolName: "Write", input };

  // Fall back to the reported category.
  switch (info.kind) {
    case "edit":
    case "delete":
    case "move":
      // A write-class change we couldn't shape-match; gate it as a Write so the
      // human still reviews it (path carried on file_path).
      return { toolName: "Write", input };
    case "execute":
      return { toolName: "Bash", input };
    case "search":
      return { toolName: "Grep", input };
    case "fetch":
      return { toolName: "WebFetch", input };
    default:
      // read / think / switch_mode / other — non-write, passes the gate freely.
      return { toolName: "Read", input };
  }
}
