#!/usr/bin/env node
import { spawn } from "node:child_process";
import type { DialMode } from "@governor/contracts";
import { startGovernorServer } from "@governor/server";
import { parseCliArgs } from "./args.ts";

function usage(): void {
  console.log(`
Governor — pace-controlled supervised AI coding.

Usage:
  governor serve [--port <n>] [--db <path>]      Start the server; create sessions from the UI
  governor run "<task>" [--repo <path>] [--mode realtime|slowed] [--port <n>] [--db <path>]
  governor                                        Same as 'serve'

Examples:
  governor serve
  governor run "Refactor the auth module to use the new token service"
  governor run "Add tests for the parser" --repo ../my-project --mode slowed
`);
}

function parseMode(value: string | undefined): DialMode | undefined {
  if (value === undefined) return undefined;
  if (value === "realtime" || value === "slowed") return value;
  throw new Error(`Invalid --mode: ${value} (expected realtime|slowed)`);
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    }).unref();
  } catch {
    /* best-effort */
  }
}

const cli = parseCliArgs(process.argv.slice(2));
const isRun = cli.command === "run";
const isServe = cli.command === "serve" || cli.command === undefined;
if (cli.help || (!isRun && !isServe)) {
  usage();
  process.exit(cli.help ? 0 : 1);
}
if (isRun && !cli.prompt) {
  console.error("Error: `run` needs a task. Use `governor serve` to start without one.\n");
  usage();
  process.exit(1);
}

const repoPath = cli.repo ?? process.cwd();
const mode = parseMode(cli.mode);
const port = cli.port ? Number(cli.port) : 4318;
const base = `http://localhost:${port}`;

// If a Governor server is already up, attach to it; otherwise start one.
let alreadyRunning = false;
try {
  alreadyRunning = (await fetch(`${base}/healthz`)).ok;
} catch {
  alreadyRunning = false;
}

if (alreadyRunning) {
  if (isRun) {
    const res = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoPath, prompt: cli.prompt, mode }),
    });
    if (!res.ok) {
      console.error(`Failed to add session: ${await res.text()}`);
      process.exit(1);
    }
    console.log(`\n  Added a session to the Governor running at ${base}\n`);
  } else {
    console.log(`\n  Governor is already running at ${base}\n`);
  }
  openBrowser(base);
  process.exit(0);
}

const server = await startGovernorServer({
  ...(isRun ? { repoPath, prompt: cli.prompt, mode } : {}),
  port: cli.port ? Number(cli.port) : undefined,
  dbPath: cli.db,
});
console.log("\n  Governor is running.");
if (isRun) console.log(`  Repo:  ${repoPath}`);
console.log(`  Open:  ${server.url}`);
console.log("  (stays up — create sessions from the UI or another `governor run`)\n");
openBrowser(server.url);
process.on("SIGINT", () => void server.close().then(() => process.exit(0)));
await new Promise(() => {}); // foreground until Ctrl-C
