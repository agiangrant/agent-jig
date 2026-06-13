// Only write-class calls gate. Reads/search/tests pass freely so a blocked
// agent can still read, plan, and test ("backpressure on writes, not thought").

export const WRITE_CLASS_TOOLS: ReadonlySet<string> = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

export function isWriteClass(toolName: string): boolean {
  return WRITE_CLASS_TOOLS.has(toolName);
}

/** Best-effort target path of a write-class tool, for risk scoring and the queue. */
export function extractPath(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const o = input as Record<string, unknown>;
  const candidate = o.file_path ?? o.notebook_path ?? o.path;
  return typeof candidate === "string" ? candidate : null;
}
