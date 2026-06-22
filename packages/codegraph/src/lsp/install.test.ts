import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  archiveExt,
  assetName,
  isInstallable,
  listServerStatus,
  lspHome,
  resolveServer,
  targetTriple,
} from "./install.ts";
import { descriptorById, type ServerDescriptor } from "./registry.ts";

/** Tests know these ids exist; narrow without a non-null assertion. */
function desc(id: string): ServerDescriptor {
  const d = descriptorById(id);
  if (!d) throw new Error(`no descriptor for ${id}`);
  return d;
}

const prevHome = process.env.JIG_LSP_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lsp-home-"));
  process.env.JIG_LSP_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.JIG_LSP_HOME;
  else process.env.JIG_LSP_HOME = prevHome;
});

describe("release-asset helpers", () => {
  it("maps host platform/arch to a rust target triple", () => {
    expect(targetTriple("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(targetTriple("darwin", "x64")).toBe("x86_64-apple-darwin");
    expect(targetTriple("linux", "x64")).toBe("x86_64-unknown-linux-gnu");
    expect(targetTriple("win32", "x64")).toBe("x86_64-pc-windows-msvc");
    expect(targetTriple("sunos", "sparc")).toBeNull();
  });

  it("picks the archive format per platform and builds the asset name", () => {
    expect(archiveExt("linux")).toBe("tar.gz");
    expect(archiveExt("win32")).toBe("zip");
    // Matches astral-sh/ty's real release assets.
    expect(assetName("ty", "aarch64-apple-darwin", "tar.gz")).toBe(
      "ty-aarch64-apple-darwin.tar.gz",
    );
  });
});

describe("install metadata", () => {
  it("honors JIG_LSP_HOME", () => {
    expect(lspHome()).toBe(home);
  });

  it("marks npm and github servers installable, toolchain ones not", () => {
    expect(isInstallable(desc("vtsls"))).toBe(true); // npm
    expect(isInstallable(desc("ty"))).toBe(true); // github binary
    expect(isInstallable(desc("gopls"))).toBe(false); // manual toolchain
  });
});

describe("resolveServer", () => {
  it("launches a native (github) server via its downloaded binary", () => {
    const bin = join(home, "ty", "ty");
    mkdirSync(join(home, "ty"), { recursive: true });
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    expect(resolveServer(desc("ty"), "/some/repo")).toEqual({ command: bin, args: ["server"] });
  });

  it("launches a node (npm) server via process.execPath + its JS entry, not the shim", () => {
    const pkgDir = join(home, "vtsls", "node_modules", "@vtsls", "language-server");
    mkdirSync(join(pkgDir, "bin"), { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ bin: { vtsls: "./bin/vtsls.js" } }),
    );
    writeFileSync(join(pkgDir, "bin", "vtsls.js"), "// entry");
    expect(resolveServer(desc("vtsls"), "/some/repo")).toEqual({
      command: process.execPath,
      args: [join(pkgDir, "bin", "vtsls.js"), "--stdio"],
    });
  });

  it("returns null when nothing is installed or on PATH", () => {
    const prevPath = process.env.PATH;
    process.env.PATH = mkdtempSync(join(tmpdir(), "empty-path-"));
    try {
      expect(resolveServer(desc("ty"), "/some/repo")).toBeNull();
    } finally {
      process.env.PATH = prevPath;
    }
  });
});

describe("listServerStatus", () => {
  it("reports each registry server's install state", () => {
    const prevPath = process.env.PATH;
    process.env.PATH = mkdtempSync(join(tmpdir(), "empty-path-"));
    try {
      const byId = Object.fromEntries(listServerStatus("/some/repo").map((s) => [s.serverId, s]));
      expect(byId.vtsls?.status).toBe("installable"); // npm, not yet installed
      expect(byId.ty?.status).toBe("installable"); // github binary
      expect(byId.gopls).toMatchObject({ status: "manual", language: "Go" });
      expect(byId.gopls?.hint).toContain("gopls");
    } finally {
      process.env.PATH = prevPath;
    }
  });
});
