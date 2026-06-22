#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DialMode } from "@agent-jig/contracts";
import { startJigServer } from "@agent-jig/server";
import { parseCliArgs } from "./args.ts";

function usage(): void {
  console.log(`
Jig — pace-controlled supervised AI coding.

Usage:
  jig serve [--port <n>] [--db <path>]      Start the server; create sessions from the UI
  jig run "<task>" [--repo <path>] [--mode realtime|slowed] [--port <n>] [--db <path>]
  jig                                        Same as 'serve'

Examples:
  jig serve
  jig run "Refactor the auth module to use the new token service"
  jig run "Add tests for the parser" --repo ../my-project --mode slowed
`);
}

function parseMode(value: string | undefined): DialMode | undefined {
  if (value === undefined) return undefined;
  if (value === "realtime" || value === "slowed") return value;
  throw new Error(`Invalid --mode: ${value} (expected realtime|slowed)`);
}

/** True when running under WSL — where the browser lives on the Windows side. */
function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  return (
    Boolean(process.env.WSL_DISTRO_NAME ?? process.env.WSL_INTEROP) || /microsoft/i.test(release())
  );
}

function openBrowser(url: string): void {
  // Under WSL, `xdg-open` has no desktop to talk to; `wslview` (from wslu) opens
  // the Windows default browser, which reaches this server over WSL's localhost
  // forwarding. Try it first there, then fall back to `xdg-open`.
  const candidates =
    process.platform === "darwin"
      ? ["open"]
      : process.platform === "win32"
        ? ["start"]
        : isWsl()
          ? ["wslview", "xdg-open"]
          : ["xdg-open"];
  // spawn() reports a missing command via an async 'error' event, not a throw,
  // so fall through the candidates on error rather than in a try/catch.
  const tryAt = (i: number): void => {
    const cmd = candidates[i];
    if (!cmd) return;
    try {
      const child = spawn(cmd, [url], {
        stdio: "ignore",
        detached: true,
        shell: process.platform === "win32",
      });
      child.on("error", () => tryAt(i + 1));
      child.unref();
    } catch {
      tryAt(i + 1);
    }
  };
  tryAt(0);
}

/** A built Jig desktop executable, if one is installed or release-built. */
function desktopExecutable(): string | null {
  // apps/cli/src/index.ts → repo root is three directories up.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const candidates = [
    "/Applications/Jig.app/Contents/MacOS/Jig",
    join(repoRoot, "apps/desktop/src-tauri/target/release/jig-desktop"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Open the Jig UI for `url`. Prefer the native desktop app when one is
 * built/installed — we launch its executable directly and pass `JIG_ATTACH`
 * so it binds to *this* server instead of spawning its own sidecar. Otherwise
 * fall back to the browser. (In a dev checkout with no release build, this is
 * the browser — run the desktop separately with `pnpm --filter @agent-jig/desktop dev`.)
 */
function openUi(url: string): void {
  const exe = desktopExecutable();
  if (exe) {
    try {
      spawn(exe, [], {
        stdio: "ignore",
        detached: true,
        env: { ...process.env, JIG_ATTACH: url },
      }).unref();
      return;
    } catch {
      /* fall back to the browser */
    }
  }
  openBrowser(url);
}

const cli = parseCliArgs(process.argv.slice(2));
const isRun = cli.command === "run";
const isServe = cli.command === "serve" || cli.command === undefined;
if (cli.help || (!isRun && !isServe)) {
  usage();
  process.exit(cli.help ? 0 : 1);
}
if (isRun && !cli.prompt) {
  console.error("Error: `run` needs a task. Use `jig serve` to start without one.\n");
  usage();
  process.exit(1);
}

const repoPath = cli.repo ?? process.cwd();
const mode = parseMode(cli.mode);
const port = cli.port ? Number(cli.port) : 4318;
const base = `http://localhost:${port}`;

// If a Jig server is already up, attach to it; otherwise start one.
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
    console.log(`\n  Added a session to the Jig running at ${base}\n`);
  } else {
    console.log(`\n  Jig is already running at ${base}\n`);
  }
  openUi(base);
  process.exit(0);
}

const server = await startJigServer({
  ...(isRun ? { repoPath, prompt: cli.prompt, mode } : {}),
  port: cli.port ? Number(cli.port) : undefined,
  dbPath: cli.db,
});
console.log("\n  Jig is running.");
if (isRun) console.log(`  Repo:  ${repoPath}`);
console.log(`  Open:  ${server.url}`);
console.log("  (stays up — create sessions from the UI or another `jig run`)\n");
openUi(server.url);
process.on("SIGINT", () => void server.close().then(() => process.exit(0)));
await new Promise(() => {}); // foreground until Ctrl-C
