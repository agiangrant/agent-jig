// Hack on the server without the CLI. Starts clean by default — create sessions
// from the UI's New Session modal. Set GOVERNOR_REPO (+ optional GOVERNOR_TASK)
// to also spin up one session at boot.
import { startGovernorServer } from "./index.ts";

const repoPath = process.env.GOVERNOR_REPO;
const prompt = process.env.GOVERNOR_TASK ?? "Explore this repository and summarize its structure.";

const server = await startGovernorServer(repoPath ? { repoPath, prompt } : {});
console.log(`Governor dev server: ${server.url}`);
process.on("SIGINT", () => void server.close().then(() => process.exit(0)));
await new Promise(() => {}); // stay up for more sessions until Ctrl-C
