import { parseArgs } from "node:util";

export interface CliArgs {
  help: boolean;
  command: string | undefined;
  prompt: string;
  repo: string | undefined;
  mode: string | undefined;
  port: string | undefined;
  db: string | undefined;
}

export function parseCliArgs(argv: string[]): CliArgs {
  // pnpm forwards a literal `--` into the script's args; Node's parseArgs treats
  // everything after a leading `--` as positional, which would swallow our flags
  // (e.g. --repo) into the task prompt. Drop one leading `--` so flags parse.
  const args = argv[0] === "--" ? argv.slice(1) : argv;

  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      mode: { type: "string" },
      port: { type: "string" },
      db: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  const [command, ...taskParts] = positionals;
  return {
    help: values.help ?? false,
    command,
    prompt: taskParts.join(" ").trim(),
    repo: values.repo,
    mode: values.mode,
    port: values.port,
    db: values.db,
  };
}
