import type { FileSlice } from "@agent-jig/contracts";

/**
 * Fetch a slice of a worktree file from the server (`GET /sessions/:id/file`).
 * The browser can't read disk, so the Review tab reads context around an edit
 * and previews touched files through this route. `from`/`to` are 1-indexed and
 * inclusive; pass `full` (or neither) for the whole file.
 */
export async function fetchFileSlice(
  base: string,
  sessionId: string,
  path: string,
  opts: { from?: number; to?: number; full?: boolean } = {},
): Promise<FileSlice> {
  const q = new URLSearchParams({ path });
  if (opts.full) q.set("full", "1");
  else {
    if (opts.from !== undefined) q.set("from", String(opts.from));
    if (opts.to !== undefined) q.set("to", String(opts.to));
  }
  const url = `${base}/sessions/${sessionId}/file?${q}`;
  const res = await fetch(url);
  if (!res.ok) {
    const msg = await res
      .json()
      .then((b: { error?: string }) => b.error)
      .catch(() => null);
    throw new Error(msg ?? `could not read ${path} (${res.status})`);
  }
  // A stale server (without this route) answers the SPA fallback — HTML, not JSON.
  // Detect that explicitly so the user sees a clear message, not a parse error.
  if (!res.headers.get("content-type")?.includes("application/json")) {
    throw new Error("unexpected response — restart the Jig server to pick up the file route");
  }
  return (await res.json()) as FileSlice;
}
