import type { ReviewFileDiff } from "@agent-jig/contracts";

/** A review comment as the model emits it (before Jig assigns id/author/etc.). */
export interface RawReviewComment {
  path: string;
  line: number;
  side: "old" | "new";
  severity: "info" | "warning" | "issue";
  body: string;
}

/** The default reviewing guidance — the part a user can override with their own. */
export const REVIEWER_GUIDANCE = `You are a senior code reviewer inside Jig. You are given the net diff of a coding session (first edit to last) and may read the repository with your read-only tools for context. You CANNOT edit files.

Review the change for correctness bugs, security issues, and clear design/quality problems. Be specific and actionable; skip nitpicks and style unless they cause real harm. Anchor each comment to a concrete line in the diff.`;

/**
 * How to post comments back to Jig — the output contract. Always injected, even
 * when the user supplies their own guidance, so findings still parse.
 */
export const REVIEWER_PROTOCOL = `Respond with ONLY a JSON array (no prose, no markdown fences) of comments:
[{"path": "<repo-relative path>", "line": <number>, "side": "new" | "old", "severity": "info" | "warning" | "issue", "body": "<the comment>"}]
Use "new" for added/context lines and "old" for removed lines, with the line number shown in the diff. Use severity "issue" for must-fix problems and "warning"/"info" for suggestions. Return [] if there is nothing worth flagging.`;

/** Compose the reviewer system prompt: the user's guidance (or the default) + the protocol. */
export function reviewerSystem(override?: string | null): string {
  const guidance = override?.trim() ? override.trim() : REVIEWER_GUIDANCE;
  return `${guidance}\n\n${REVIEWER_PROTOCOL}`;
}

/** Render the structured diff with per-side line numbers for the reviewer prompt. */
function renderDiff(files: ReviewFileDiff[]): string {
  const parts: string[] = [];
  for (const f of files) {
    parts.push(
      `File: ${f.path}${f.oldPath && f.oldPath !== f.path ? ` (was ${f.oldPath})` : ""} [${f.status}]`,
    );
    for (const h of f.hunks) {
      parts.push(h.header);
      for (const r of h.rows) {
        const sign = r.kind === "add" ? "+" : r.kind === "del" ? "-" : " ";
        const ln = r.kind === "del" ? r.oldLine : r.newLine;
        parts.push(`${sign}${String(ln ?? "").padStart(5)} | ${r.text}`);
      }
    }
    parts.push("");
  }
  return parts.join("\n");
}

export function buildReviewPrompt(
  files: ReviewFileDiff[],
  task: string,
  transcript: string,
): string {
  return [
    `Task the agent was given:\n${task || "(none recorded)"}`,
    transcript ? `\nWhat the agent did:\n${transcript}` : "",
    `\nThe net diff to review (line numbers shown after the +/-/space sign):\n${renderDiff(files)}`,
    `\nReturn your review as the JSON array described in your instructions.`,
  ].join("\n");
}

/** Best-effort extraction of the JSON array of comments from the model's text. */
export function parseReviewComments(text: string): RawReviewComment[] {
  const json = extractJsonArray(text);
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: RawReviewComment[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.path !== "string" || typeof o.body !== "string") continue;
    const line = typeof o.line === "number" ? o.line : Number(o.line);
    if (!Number.isFinite(line)) continue;
    out.push({
      path: o.path,
      line,
      side: o.side === "old" ? "old" : "new",
      severity: o.severity === "warning" || o.severity === "issue" ? o.severity : "info",
      body: o.body,
    });
  }
  return out;
}

/** Pull the first balanced top-level [ … ] out of the text (tolerates fences/prose). */
function extractJsonArray(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  if (fence?.[1]) return fence[1];
  const start = text.indexOf("[");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
