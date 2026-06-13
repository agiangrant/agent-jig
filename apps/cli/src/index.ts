#!/usr/bin/env node
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import type { DialMode } from "@governor/contracts";
import { startGovernorServer } from "@governor/server";

function usage(): void {
  console.log(`
Governor — pace-controlled supervised AI coding.

Usage:
  governor run "<task>" [--repo <path>] [--mode realtime|slowed] [--port <n>] [--db <path>]

Examples:
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

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: "string" },
    mode: { type: "string" },
    port: { type: "string" },
    db: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const [command, ...taskParts] = positionals;
if (values.help || command !== "run") {
  usage();
  process.exit(values.help || command === undefined ? 0 : 1);
}

const prompt = taskParts.join(" ").trim();
if (!prompt) {
  console.error("Error: a task prompt is required.\n");
  usage();
  process.exit(1);
}

const repoPath = values.repo ?? process.cwd();
const server = await startGovernorServer({
  repoPath,
  prompt,
  mode: parseMode(values.mode),
  port: values.port ? Number(values.port) : undefined,
  dbPath: values.db,
});

console.log("\n  Governor is supervising the agent.");
console.log(`  Repo:  ${repoPath}`);
console.log(`  Open:  ${server.url}\n`);
openBrowser(server.url);

try {
  await server.done;
  console.log("\n  Session complete.");
} finally {
  await server.close();
}
