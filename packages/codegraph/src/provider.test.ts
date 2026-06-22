import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRelative } from "./resolve.ts";

const root = mkdtempSync(join(tmpdir(), "codegraph-prov-"));

describe("resolveRelative (degraded resolver)", () => {
  it("resolves a relative specifier to a sibling file with an inferred extension", () => {
    writeFileSync(join(root, "a.ts"), "");
    writeFileSync(join(root, "b.ts"), "");
    expect(resolveRelative("./b", join(root, "a.ts"))).toBe(join(root, "b.ts"));
  });

  it("resolves a directory specifier to its index file", () => {
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(join(root, "lib", "index.ts"), "");
    expect(resolveRelative("./lib", join(root, "a.ts"))).toBe(join(root, "lib", "index.ts"));
  });

  it("ignores bare (non-relative) specifiers — those need a language server", () => {
    expect(resolveRelative("@agent-jig/core", join(root, "a.ts"))).toBeNull();
    expect(resolveRelative("react", join(root, "a.ts"))).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(resolveRelative("./missing", join(root, "a.ts"))).toBeNull();
  });
});
