// Build the Node sidecar that the packaged desktop app ships and runs.
//
// In a dev checkout the Tauri shell boots the server straight from TypeScript
// (`node --import tsx apps/server/src/serve-headless.ts`). That can't ship: a
// distributed `.app`/`.msi`/`.AppImage` has no repo source and no tsx. So for a
// release build we produce a self-contained sidecar under `src-tauri/sidecar/`:
//
//   sidecar/server.mjs      — all first-party @agent-jig/* TS bundled into one ESM file
//   sidecar/node_modules/   — the prod third-party deps that must stay on disk
//
// The host's Node 24 runs `node server.mjs` (we require host Node for now — see
// the packaging notes). Third-party packages are left EXTERNAL and shipped as a
// real node_modules because several resolve assets from disk at runtime and
// cannot be inlined: `web-tree-sitter` + `tree-sitter-wasms` load `.wasm`
// grammars via `require.resolve`, and `@anthropic-ai/claude-agent-sdk` extracts
// a per-platform native binary. esbuild only collapses the workspace TS.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const outDir = resolve(here, "..", "src-tauri", "sidecar");
const entry = join(repoRoot, "apps/server/src/serve-headless.ts");

// Bundle every first-party @agent-jig/* package (raw TypeScript, no build step)
// into the output; externalize everything else so it loads from node_modules at
// runtime. node: builtins are bare specifiers too and fall through to external.
const externalizeNpm = {
  name: "externalize-npm",
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      // The filter also matches the entry point and absolute paths — on Windows
      // the entry is an absolute `D:\...` path with no leading `.`/`/`. Never
      // externalize those (esbuild errors on an external entry point); only bare
      // npm specifiers. Bundle our own @agent-jig/* workspace packages.
      if (args.kind === "entry-point" || isAbsolute(args.path)) return null;
      if (args.path.startsWith("@agent-jig/")) return null;
      return { external: true };
    });
  },
};

console.log("• bundling first-party TS → server.mjs");
rmSync(outDir, { recursive: true, force: true });
await esbuild.build({
  entryPoints: [entry],
  outfile: join(outDir, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  plugins: [externalizeNpm],
  logLevel: "info",
});

// Materialize a portable, hoisted, dereferenced prod node_modules for the server
// package via `pnpm deploy` (resolves the full third-party closure, including the
// agent SDK's matching native binary for THIS build host). We keep only its
// node_modules — the bundle already contains all the first-party code.
console.log("• resolving prod node_modules (pnpm deploy)");
const deployDir = mkdtempSync(join(tmpdir(), "jig-sidecar-"));
try {
  // `node-linker=hoisted` flattens the whole prod closure to a single top-level
  // node_modules. The bundle inlined every @agent-jig/* package, so their
  // transitive third-party deps (e.g. zod, pulled in via the agent SDK) must be
  // resolvable from the ONE node_modules beside server.mjs — pnpm's default
  // nested layout would hide them under each (now-inlined) workspace package.
  //
  // Argument array (no shell on POSIX); pnpm on Windows is a `.cmd`, so a shell
  // is required there to resolve it. `deployDir` is a self-generated temp path.
  execFileSync(
    "pnpm",
    [
      "--filter",
      "@agent-jig/server",
      "--config.node-linker=hoisted",
      "deploy",
      "--prod",
      "--legacy",
      deployDir,
    ],
    { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
  );
  const deployedModules = join(deployDir, "node_modules");
  if (!existsSync(deployedModules)) throw new Error("pnpm deploy produced no node_modules");
  const shippedModules = join(outDir, "node_modules");
  cpSync(deployedModules, shippedModules, { recursive: true, dereference: true });
  // pnpm writes `.bin/*` as absolute symlinks into the (now-deleted) temp deploy
  // dir, leaving them dangling — and Tauri's resource walker rejects dangling
  // links. The server imports packages directly and never needs these CLI shims.
  rmSync(join(shippedModules, ".bin"), { recursive: true, force: true });
} finally {
  rmSync(deployDir, { recursive: true, force: true });
}

console.log(`✓ sidecar ready → ${outDir}`);
