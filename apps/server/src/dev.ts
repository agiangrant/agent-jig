// Hack on the server without the CLI: GOVERNOR_REPO / GOVERNOR_TASK env vars.
import { startGovernorServer } from "./index.ts";

const repoPath = process.env.GOVERNOR_REPO ?? process.cwd();
const prompt = process.env.GOVERNOR_TASK ?? "Explore this repository and summarize its structure.";

const server = await startGovernorServer({ repoPath, prompt });
console.log(`Governor dev server: ${server.url}`);
process.on("SIGINT", () => void server.close().then(() => process.exit(0)));
await new Promise(() => {}); // stay up for more sessions until Ctrl-C
