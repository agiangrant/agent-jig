import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorktree, Worktree } from "./index.ts";

let dir: string;
const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wt-"));
  git("init");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-m", "baseline");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Worktree", () => {
  it("detects an out-of-band modification", () => {
    const wt = new Worktree(dir);
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
    expect(wt.detect()).toEqual([{ path: "a.ts", kind: "modified" }]);
  });

  it("ignores a change the agent declared as expected", () => {
    const wt = new Worktree(dir);
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
    expect(wt.detect(["a.ts"])).toEqual([]);
  });

  it("excludes an expected path given as an absolute path (git reports relative)", () => {
    const wt = new Worktree(dir);
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
    expect(wt.detect([join(dir, "a.ts")])).toEqual([]);
  });

  it("detects a new untracked file as added", () => {
    const wt = new Worktree(dir);
    writeFileSync(join(dir, "b.ts"), "export const b = 1;\n");
    expect(wt.detect()).toEqual([{ path: "b.ts", kind: "added" }]);
  });

  it("advances its baseline so a change is reported once", () => {
    const wt = new Worktree(dir);
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
    expect(wt.detect()).toHaveLength(1);
    expect(wt.detect()).toEqual([]);
  });

  it("is a no-op outside a git repo", () => {
    const plain = mkdtempSync(join(tmpdir(), "plain-"));
    const wt = new Worktree(plain);
    expect(wt.isGit).toBe(false);
    writeFileSync(join(plain, "x.ts"), "x");
    expect(wt.detect()).toEqual([]);
    rmSync(plain, { recursive: true, force: true });
  });
});

describe("createWorktree", () => {
  it("creates an isolated worktree on a fresh branch off HEAD", () => {
    const base = mkdtempSync(join(tmpdir(), "wt-base-"));
    const { path, branch } = createWorktree(dir, base);
    try {
      expect(branch).toMatch(/^jig\//);
      expect(existsSync(join(path, "a.ts"))).toBe(true); // checked out from HEAD
      const list = execFileSync("git", ["-C", dir, "worktree", "list"], { encoding: "utf8" });
      expect(list).toContain(path);
    } finally {
      execFileSync("git", ["-C", dir, "worktree", "remove", "--force", path], { stdio: "ignore" });
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("throws outside a git repo", () => {
    const plain = mkdtempSync(join(tmpdir(), "plain-"));
    expect(() => createWorktree(plain)).toThrow();
    rmSync(plain, { recursive: true, force: true });
  });
});
