import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorktree, headRef, parseGitDiff, Worktree } from "./index.ts";

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

describe("parseGitDiff", () => {
  it("parses a modification into rows with both line numbers", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "index 111..222 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,2 @@",
      " const x = 1;",
      "-const y = 2;",
      "+const y = 3;",
      "",
    ].join("\n");
    const [file] = parseGitDiff(diff);
    expect(file?.path).toBe("a.ts");
    expect(file?.status).toBe("modified");
    expect(file?.hunks[0]?.rows).toEqual([
      { kind: "context", text: "const x = 1;", oldLine: 1, newLine: 1 },
      { kind: "del", text: "const y = 2;", oldLine: 2, newLine: null },
      { kind: "add", text: "const y = 3;", oldLine: null, newLine: 2 },
    ]);
  });

  it("marks a new file as added and a removed file as deleted", () => {
    const added = parseGitDiff(
      [
        "diff --git a/n.ts b/n.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/n.ts",
        "@@ -0,0 +1 @@",
        "+hi",
      ].join("\n"),
    );
    expect(added[0]).toMatchObject({ path: "n.ts", status: "added" });
    const deleted = parseGitDiff(
      [
        "diff --git a/o.ts b/o.ts",
        "deleted file mode 100644",
        "--- a/o.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-bye",
      ].join("\n"),
    );
    expect(deleted[0]).toMatchObject({ path: "o.ts", status: "deleted" });
  });
});

describe("Worktree.diff + headRef", () => {
  it("returns the net change (modified + untracked) against the base commit", () => {
    const base = headRef(dir);
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n"); // modify tracked
    writeFileSync(join(dir, "b.ts"), "export const b = 9;\n"); // new untracked
    const files = new Worktree(dir).diff(base ?? "HEAD");
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath["a.ts"]?.status).toBe("modified");
    expect(byPath["b.ts"]?.status).toBe("added");
    expect(byPath["b.ts"]?.hunks[0]?.rows[0]).toMatchObject({
      kind: "add",
      text: "export const b = 9;",
      newLine: 1,
    });
  });
});
