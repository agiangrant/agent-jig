import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/src/**/*.test.ts", "apps/**/src/**/*.test.ts"],
    // Web ships pure-logic tests (e.g. the diff row-model) that run in node; only
    // Svelte component tests would need a browser env, and there are none yet.
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
