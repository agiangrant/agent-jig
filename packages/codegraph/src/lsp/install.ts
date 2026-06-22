import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { allServers, type ServerDescriptor } from "./registry.ts";

/** A registry server plus whether it's ready to use in this session. */
export interface ServerStatus {
  serverId: string;
  language: string;
  status: "installed" | "installable" | "manual";
  /** For `manual` servers: the toolchain command to install it. */
  hint: string;
}

/** The full registry with per-session install state, for the install UI. */
export function listServerStatus(repoRoot: string): ServerStatus[] {
  return allServers().map((desc) => {
    const installed = resolveServer(desc, repoRoot) !== null;
    const status = installed ? "installed" : isInstallable(desc) ? "installable" : "manual";
    return {
      serverId: desc.serverId,
      language: desc.language,
      status,
      hint: desc.install.kind === "manual" ? desc.install.hint : "",
    };
  });
}

/** How to actually launch a resolved server: a command + its stdio-LSP args. */
export interface ResolvedServer {
  command: string;
  args: string[];
}

/** Where on-demand servers live, per-server so languages stay isolated. */
export function lspHome(): string {
  return process.env.JIG_LSP_HOME ?? join(homedir(), ".jig", "lsp");
}

/** Can this server be auto-installed (vs a toolchain-distributed manual one)? */
export function isInstallable(desc: ServerDescriptor): boolean {
  return desc.install.kind === "npm" || desc.install.kind === "github";
}

/**
 * Resolve how to launch an already-available server, or null if none is found.
 * Node-based (npm) servers launch via the running Node (`process.execPath` + the
 * package's JS entry) — never the `.bin` shebang shim, which would need `node` on
 * PATH and so fail in a Finder-launched packaged app. Native (github) servers run
 * their downloaded binary directly.
 */
export function resolveServer(desc: ServerDescriptor, repoRoot: string): ResolvedServer | null {
  if (desc.install.kind === "npm") {
    for (const base of [join(lspHome(), desc.serverId), repoRoot]) {
      const js = npmBinEntry(desc.install.pkg, desc.bin, base);
      if (js) return { command: process.execPath, args: [js, ...desc.args] };
    }
    const onPath = whichOnPath(desc.bin);
    return onPath ? { command: onPath, args: desc.args } : null;
  }
  if (desc.install.kind === "github") {
    const found = findBinary(join(lspHome(), desc.serverId), desc.bin);
    if (found) return { command: found, args: desc.args };
  }
  const onPath = whichOnPath(desc.bin);
  return onPath ? { command: onPath, args: desc.args } : null;
}

/**
 * Install a server on demand. npm servers go through the Node-bundled npm (located
 * via `process.execPath`, not the user's PATH) so dependencies resolve correctly
 * with no global npm. github servers download + extract a release binary. Returns
 * how to launch it, or null (manual servers / failure — caller stays degraded).
 */
export async function installServer(desc: ServerDescriptor): Promise<ResolvedServer | null> {
  if (desc.install.kind === "npm") return installViaNpm(desc, desc.install);
  if (desc.install.kind === "github") return installFromGithub(desc, desc.install.repo);
  return null;
}

// --- npm path: drive the Node-bundled npm via process.execPath ---

async function installViaNpm(
  desc: ServerDescriptor,
  spec: { pkg: string; version: string },
): Promise<ResolvedServer | null> {
  const target = join(lspHome(), desc.serverId);
  mkdirSync(target, { recursive: true });
  const flags = ["install", "--prefix", target, "--no-audit", "--no-fund", "--no-save"];
  const pkg = `${spec.pkg}@${spec.version}`;

  const npmCli = nodeBundledNpmCli();
  const ok = npmCli
    ? await run(process.execPath, [npmCli, ...flags, pkg])
    : await run("npm", [...flags, pkg]); // last-resort PATH fallback (dev shells)
  return ok ? resolveServer(desc, target) : null;
}

/** The npm-cli.js that ships alongside the running Node — independent of PATH. */
export function nodeBundledNpmCli(): string | null {
  const dir = dirname(process.execPath);
  const candidates = [
    join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), // unix layout
    join(dir, "node_modules", "npm", "bin", "npm-cli.js"), // windows layout
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** Resolve a package's JS bin entry from its installed package.json `bin` field. */
function npmBinEntry(pkg: string, binName: string, base: string): string | null {
  const pkgDir = join(base, "node_modules", pkg);
  try {
    const meta = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
      bin?: string | Record<string, string>;
    };
    let rel: string | undefined;
    if (typeof meta.bin === "string") rel = meta.bin;
    else if (meta.bin) rel = meta.bin[binName] ?? Object.values(meta.bin)[0];
    if (!rel) return null;
    const js = join(pkgDir, rel);
    return existsSync(js) ? js : null;
  } catch {
    return null;
  }
}

// --- github path: download + extract a native release binary ---

async function installFromGithub(
  desc: ServerDescriptor,
  repo: string,
): Promise<ResolvedServer | null> {
  const triple = targetTriple(process.platform, process.arch);
  if (!triple) return null;
  const asset = assetName(desc.bin, triple, archiveExt(process.platform));

  const release = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`);
  const assets = (release?.assets ?? []) as { name: string; browser_download_url: string }[];
  const archive = assets.find((a) => a.name === asset);
  if (!archive) return null;

  const target = join(lspHome(), desc.serverId);
  mkdirSync(target, { recursive: true });
  const archivePath = join(target, asset);
  if (!(await download(archive.browser_download_url, archivePath))) return null;

  // Integrity: verify against the sibling .sha256 when the release ships one.
  const sha = assets.find((a) => a.name === `${asset}.sha256`);
  if (sha) {
    const expected = (await fetchText(sha.browser_download_url)).trim().split(/\s+/)[0] ?? "";
    if (expected && sha256(archivePath) !== expected.toLowerCase()) {
      rmSync(archivePath, { force: true });
      return null;
    }
  }

  // bsdtar (/usr/bin/tar on macOS/Linux, System32 tar.exe on Windows) extracts
  // both .tar.gz and .zip with -xf, and lives in the minimal GUI PATH.
  const extracted = await run("tar", ["-xf", archivePath, "-C", target]);
  rmSync(archivePath, { force: true });
  if (!extracted) return null;

  const bin = findBinary(target, desc.bin);
  if (!bin) return null;
  try {
    chmodSync(bin, 0o755);
  } catch {}
  return { command: bin, args: desc.args };
}

/** rust target triple for the current host, or null if unsupported. */
export function targetTriple(platform: NodeJS.Platform, arch: string): string | null {
  const key = `${platform}-${arch}`;
  const map: Record<string, string> = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "linux-arm64": "aarch64-unknown-linux-gnu",
    "win32-x64": "x86_64-pc-windows-msvc",
    "win32-arm64": "aarch64-pc-windows-msvc",
  };
  return map[key] ?? null;
}

export function archiveExt(platform: NodeJS.Platform): string {
  return platform === "win32" ? "zip" : "tar.gz";
}

export function assetName(binPrefix: string, triple: string, ext: string): string {
  return `${binPrefix}-${triple}.${ext}`;
}

// --- shared helpers ---

/** Recursively find an executable named `name` (or `name.exe`) under `dir`. */
function findBinary(dir: string, name: string): string | null {
  if (!existsSync(dir)) return null;
  const wanted = new Set([name, `${name}.exe`]);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findBinary(full, name);
      if (hit) return hit;
    } else if (wanted.has(entry.name) && statSync(full).isFile()) {
      return full;
    }
  }
  return null;
}

function whichOnPath(bin: string): string | null {
  const names = process.platform === "win32" ? [`${bin}.exe`, `${bin}.cmd`, bin] : [bin];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const candidate = join(dir, n);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function fetchJson(url: string): Promise<{ assets?: unknown[] } | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "jig", Accept: "application/vnd.github+json" },
    });
    return res.ok ? ((await res.json()) as { assets?: unknown[] }) : null;
  } catch {
    return null;
  }
}

async function fetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "jig" } });
    return res.ok ? await res.text() : "";
  } catch {
    return "";
  }
}

async function download(url: string, dest: string): Promise<boolean> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "jig" }, redirect: "follow" });
    if (!res.ok) return false;
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    return true;
  } catch {
    return false;
  }
}

function run(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}
