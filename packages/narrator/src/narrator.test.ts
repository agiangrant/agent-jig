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
});
