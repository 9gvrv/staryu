import { basename } from "node:path";

let cachedBase: string | null = null;

function detectBaseCommand(): string {
  const argv1 = (process.argv[1] ?? "").replace(/\\/g, "/");

  if (process.env.npm_command === "exec" || argv1.includes("/_npx/")) {
    return "npx staryu";
  }
  if (argv1.includes("/.bunx/") || argv1.includes("/.bun/install/cache/")) {
    return "bunx staryu";
  }
  if (argv1.includes("/node_modules/staryu/") || basename(argv1) === "staryu") {
    return "staryu";
  }

  // Best default for the published package.
  return "npx staryu";
}

/**
 * Returns the command the user actually invoked staryu with, so hints say
 * `npx staryu apply` under npx, `bunx staryu apply` under bunx, and
 * `staryu apply` after a global install.
 */
export function cliCommand(subcommand?: string): string {
  cachedBase ??= detectBaseCommand();
  return subcommand ? `${cachedBase} ${subcommand}` : cachedBase;
}
