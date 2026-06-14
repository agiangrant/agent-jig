import { describe, expect, it } from "vitest";
import { createNarrator, type NarrationInput } from "./index.ts";

const input: NarrationInput = {
  toolName: "Edit",
  path: "src/client.ts",
  before: "fetch(url)",
  after: "fetchWithRetry(url)",
  reasoning: "This API rate-limits aggressively and the client swallows 429s.",
};

describe("createNarrator", () => {
  it("returns the model's one-line why", async () => {
    const narrator = createNarrator({
      generate: async () =>
        "Wrapped in a retry because the API rate-limits and 429s were being swallowed.",
    });
    expect(await narrator.narrate(input)).toContain("retry");
  });

  it("stays silent on the SILENT sentinel", async () => {
    const narrator = createNarrator({ generate: async () => "SILENT" });
    expect(await narrator.narrate(input)).toBeNull();
  });

  it("trims whitespace and treats empty output as silent", async () => {
    expect(await createNarrator({ generate: async () => "   " }).narrate(input)).toBeNull();
    expect(await createNarrator({ generate: async () => "  hi  " }).narrate(input)).toBe("hi");
  });

  it("passes reasoning and before/after to the model", async () => {
    let seen = "";
    const narrator = createNarrator({
      generate: async (_system, user) => {
        seen = user;
        return "ok";
      },
    });
    await narrator.narrate(input);
    expect(seen).toContain("rate-limits aggressively");
    expect(seen).toContain("fetchWithRetry(url)");
    expect(seen).toContain("src/client.ts");
  });

  it("never throws — a generate failure becomes silence", async () => {
    const narrator = createNarrator({
      generate: async () => {
        throw new Error("no credentials");
      },
    });
    expect(await narrator.narrate(input)).toBeNull();
  });

  describe("summarize", () => {
    it("returns a short intent label, stripped of quotes and trailing period", async () => {
      const narrator = createNarrator({ generate: async () => '"Add ZIP export."' });
      expect(await narrator.summarize("Long reasoning about adding a ZIP export…")).toBe(
        "Add ZIP export",
      );
    });

    it("sends the reasoning to the model under the intent system prompt", async () => {
      let seenSystem = "";
      let seenUser = "";
      const narrator = createNarrator({
        generate: async (system, user) => {
          seenSystem = system;
          seenUser = user;
          return "Wire xlsx parser into the import service";
        },
      });
      await narrator.summarize("We need to hook the xlsx parser into the import service.");
      expect(seenSystem).toContain("imperative");
      expect(seenUser).toContain("xlsx parser");
    });

    it("is null for empty reasoning and never throws on failure", async () => {
      expect(await createNarrator({ generate: async () => "x" }).summarize("  ")).toBeNull();
      const boom = createNarrator({
        generate: async () => {
          throw new Error("offline");
        },
      });
      expect(await boom.summarize("something")).toBeNull();
    });
  });
});
