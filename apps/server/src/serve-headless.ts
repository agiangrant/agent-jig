// Headless server entry for the Tauri desktop shell. Unlike the CLI, it never
// opens a browser; instead it binds an OS-assigned port (JIG_PORT=0) and
// prints a single machine-parseable `JIG_PORT=<n>` line on stdout that the
// Rust host reads to point the webview at the live sidecar.
import { startJigServer } from "./index.ts";

const requested = Number(process.env.JIG_PORT ?? 0);
const port = Number.isFinite(requested) ? requested : 0;

const server = await startJigServer({ port, dbPath: process.env.JIG_DB });
// The Rust host parses this exact prefix from stdout — keep it stable.
console.log(`JIG_PORT=${server.port}`);

const shutdown = () => void server.close().then(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await new Promise(() => {}); // stay up until the host tears us down
