import type { LineComment, ReviewComment } from "@agent-jig/contracts";

// Turning the developer's marked-up diff into prose the agent can act on. Line
// comments are anchored to edits (by editId); these helpers format them — per
// edit (for a targeted gate rejection) or as one block (for an injected/resumed
// directive). Pure: no I/O, so it's unit-tested here.

/** Comments grouped under one edit, in the order they were added. */
export interface EditCommentGroup {
  editId: string;
  path: string;
  comments: LineComment[];
}

/** Group line comments by their anchor edit, preserving first-seen order. */
export function groupCommentsByEdit(comments: readonly LineComment[]): EditCommentGroup[] {
  const groups = new Map<string, EditCommentGroup>();
  for (const c of comments) {
    let g = groups.get(c.editId);
    if (g === undefined) {
      g = { editId: c.editId, path: c.path, comments: [] };
      groups.set(c.editId, g);
    }
    g.comments.push(c);
  }
  return [...groups.values()];
}

/** One comment as a bullet: `- L42 (`const x = …`): handle the null case`. */
function formatComment(c: LineComment): string {
  const text = c.lineText.trim();
  const where = text ? `L${c.line} (\`${text}\`)` : `L${c.line}`;
  return `- ${where}: ${c.body.trim()}`;
}

/**
 * The feedback for a single edit: a `Re:` header naming the file, then a bullet
 * per comment. `freeText` (the shared steering message, if any) is appended so
 * each rejected edit's revision carries the overall instruction too.
 */
export function composeEditFeedback(group: EditCommentGroup, freeText = ""): string {
  const header = `Re: your edit to ${group.path}:`;
  const bullets = group.comments.map(formatComment).join("\n");
  const tail = freeText.trim() ? `\n\n${freeText.trim()}` : "";
  return `${header}\n${bullets}${tail}`;
}

/**
 * All line comments as one directive — every edit's block, separated by blank
 * lines, with the shared `freeText` last. Used when no commented edit is still
 * pending (the agent is mid-thought or finished), so there's nothing to reject
 * and the whole annotated batch goes as a single message.
 */
export function composeAllComments(comments: readonly LineComment[], freeText = ""): string {
  const blocks = groupCommentsByEdit(comments).map((g) => composeEditFeedback(g));
  const tail = freeText.trim();
  return [...blocks, ...(tail ? [tail] : [])].join("\n\n");
}

/**
 * Turn PR-review comments (human and AI, anchored by file+line, not editId) into
 * one directive for the coding agent to address. Grouped per file with a `Re:`
 * header and a bullet per comment; `freeText` (the reviewer's overall note) last.
 */
export function composeReviewFeedback(comments: readonly ReviewComment[], freeText = ""): string {
  const byPath = new Map<string, ReviewComment[]>();
  for (const c of comments) {
    const list = byPath.get(c.path);
    if (list) list.push(c);
    else byPath.set(c.path, [c]);
  }
  const blocks = [...byPath.entries()].map(([path, list]) => {
    const bullets = list
      .map((c) => {
        const text = c.lineText.trim();
        const where = text ? `L${c.line} (\`${text}\`)` : `L${c.line}`;
        const who = c.author === "human" ? "" : ` [${c.author} review]`;
        return `- ${where}${who}: ${c.body.trim()}`;
      })
      .join("\n");
    return `Re: ${path}:\n${bullets}`;
  });
  const intro = "Please address this code review:";
  const tail = freeText.trim();
  return [intro, ...blocks, ...(tail ? [tail] : [])].join("\n\n");
}
