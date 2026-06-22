// Hack on the server without the CLI. Starts clean by default — create sessions
// from the UI's New Session modal. Set JIG_REPO (+ optional JIG_TASK)
// to also spin up one session at boot.
import { startJigServer } from "./index.ts";

const repoPath = process.env.JIG_REPO;
const prompt = process.env.JIG_TASK ?? "Explore this repository and summarize its structure.";

const server = await startJigServer(repoPath ? { repoPath, prompt } : {});
console.log(`Jig dev server: ${server.url}`);
process.on("SIGINT", () => void server.close().then(() => process.exit(0)));
await new Promise(() => {}); // stay up for more sessions until Ctrl-C
