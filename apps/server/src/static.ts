import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import type { Context } from "hono";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const FALLBACK =
  "Jig server is running. Build the web UI (`pnpm --filter @agent-jig/web build`) " +
  "or run the Vite dev server (`pnpm --filter @agent-jig/web dev`).";

/**
 * Serves the built web UI from an absolute root, falling back to index.html
 * (SPA) and finally a hint when no build exists. Dependency-free so an absolute
 * root just works.
 */
export function serveWeb(webRoot: string) {
  return async (c: Context): Promise<Response> => {
    const rel = c.req.path === "/" ? "/index.html" : c.req.path;
    const file = normalize(join(webRoot, rel));
    if (!file.startsWith(webRoot)) return c.notFound();
    try {
      const data = await readFile(file);
      return new Response(data, {
        headers: { "content-type": TYPES[extname(file)] ?? "application/octet-stream" },
      });
    } catch {
      try {
        return c.html(await readFile(join(webRoot, "index.html"), "utf8"));
      } catch {
        return c.text(FALLBACK, 200);
      }
    }
  };
}
