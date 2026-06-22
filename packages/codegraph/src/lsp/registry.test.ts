import { describe, expect, it } from "vitest";
import { descriptorById, descriptorForPath } from "./registry.ts";

describe("registry", () => {
  it("maps file extensions to the best server for each language", () => {
    expect(descriptorForPath("/x/a.ts")?.serverId).toBe("vtsls");
    expect(descriptorForPath("/x/a.tsx")?.serverId).toBe("vtsls");
    expect(descriptorForPath("/x/a.py")?.serverId).toBe("ty");
    expect(descriptorForPath("/x/a.go")?.serverId).toBe("gopls");
    expect(descriptorForPath("/x/a.rs")?.serverId).toBe("rust-analyzer");
    expect(descriptorForPath("/x/a.cobol")).toBeNull();
  });

  it("derives the LSP languageId from the extension", () => {
    const ts = descriptorForPath("/x/a.tsx");
    expect(ts?.languageId(".tsx")).toBe("typescriptreact");
    expect(ts?.languageId(".ts")).toBe("typescript");
    expect(ts?.languageId(".mjs")).toBe("javascript");
  });

  it("describes how each server is obtained", () => {
    expect(descriptorById("vtsls")?.install.kind).toBe("npm");
    expect(descriptorById("ty")?.install.kind).toBe("github");
    expect(descriptorById("gopls")?.install.kind).toBe("manual");
    expect(descriptorById("nope")).toBeNull();
  });
});
