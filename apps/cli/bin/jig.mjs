#!/usr/bin/env node
// Dev launcher for the `jig` CLI. The CLI sources are raw TypeScript (the
// workspace runs everything through tsx, no build step), so register the tsx
// ESM loader before importing the entry. `tsx/esm/api` resolves from this file's
// own node_modules — not the cwd — so `jig` works from any directory. The
// packaged, bundled CLI (Milestone 3) will replace this shim with a plain JS bin.
import { register } from "tsx/esm/api";

register();
await import(new URL("../src/index.ts", import.meta.url).href);
