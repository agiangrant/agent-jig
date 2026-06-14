import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./args.ts";

describe("parseCliArgs", () => {
  it("parses flags even after a pnpm-injected leading --", () => {
    const a = parseCliArgs([
      "--",
      "run",
      "refactor the parser",
      "--repo",
      "/p/repo",
      "--mode",
      "slowed",
    ]);
    expect(a.command).toBe("run");
    expect(a.prompt).toBe("refactor the parser");
    expect(a.repo).toBe("/p/repo");
    expect(a.mode).toBe("slowed");
  });

  it("parses without a leading -- (tsx direct invocation)", () => {
    const a = parseCliArgs(["run", "fix the bug", "--repo", "/x"]);
    expect(a.command).toBe("run");
    expect(a.prompt).toBe("fix the bug");
    expect(a.repo).toBe("/x");
  });

  it("keeps --repo out of the prompt", () => {
    const a = parseCliArgs(["--", "run", "add tests", "--repo", "/x"]);
    expect(a.prompt).toBe("add tests"); // not "add tests --repo /x"
  });

  it("recognises --help through the leading --", () => {
    expect(parseCliArgs(["--", "--help"]).help).toBe(true);
  });

  it("parses `serve` with no task", () => {
    const a = parseCliArgs(["--", "serve", "--port", "5000"]);
    expect(a.command).toBe("serve");
    expect(a.prompt).toBe("");
    expect(a.port).toBe("5000");
  });
});
