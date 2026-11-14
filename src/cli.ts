import { Command } from "commander";
import pc from "picocolors";
import { VERSION } from "./version.ts";
import { UserError } from "./core/errors.ts";
import { initCommand } from "./commands/init.ts";
import { discoverCommand } from "./commands/discover.ts";
import { applyCommand } from "./commands/apply.ts";
import { syncCommand } from "./commands/sync.ts";
import { undoCommand } from "./commands/undo.ts";
import { statusCommand } from "./commands/status.ts";

interface GlobalOptions {
  debug?: boolean;
}

function debugOf(command: Command): boolean {
  const options = command.optsWithGlobals() as GlobalOptions;
  return options.debug === true;
}

function guard<Args extends unknown[]>(
  fn: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    try {
      await fn(...args);
    } catch (error) {
      if (error instanceof UserError) {
        console.error(pc.red(`Error: ${error.message}`));
      } else if (error instanceof Error) {
        console.error(pc.red(`Error: ${error.message}`));
        if (process.env.STARYU_DEBUG === "1" && error.stack) {
          console.error(pc.dim(error.stack));
        }
      } else {
        console.error(pc.red(`Error: ${String(error)}`));
      }
      process.exitCode = 1;
    }
  };
}

function parseId(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UserError(`Invalid run id: ${value}`);
  }
  return parsed;
}

export function buildCli(): Command {
  const program = new Command();

  program
    .name("staryu")
    .description("Discover repositories worth starring and organize them into a GitHub list.")
    .version(VERSION)
    .option("-d, --debug", "print GitHub request details")
    .showHelpAfterError()
    .showSuggestionAfterError();

  program
    .command("init")
    .description("save a GitHub token, infer preferences and create the list")
    .option("--force", "reconfigure even if a config already exists")
    .action(
      guard(async (options: { force?: boolean }, command: Command) => {
        await initCommand({ force: options.force, debug: debugOf(command) });
      }),
    );

  program
    .command("discover")
    .alias("explore")
    .description("search GitHub and store scored candidates without changing anything")
    .option("--reuse", "use saved preferences without asking")
    .option("--customize", "change languages, stars and activity before searching")
    .action(
      guard(
        async (options: { reuse?: boolean; customize?: boolean }, command: Command) => {
          await discoverCommand({
            debug: debugOf(command),
            reuse: options.reuse,
            customize: options.customize,
          });
        },
      ),
    );

  program
    .command("apply")
    .description("review stored candidates, star the selected ones and add them to the list")
    .option("-y, --yes", "apply the top candidates without prompting")
    .option("--run <id>", "use candidates from a specific discovery run", parseId)
    .action(
      guard(async (options: { yes?: boolean; run?: number }, command: Command) => {
        await applyCommand({
          yes: options.yes,
          runId: options.run,
          debug: debugOf(command),
        });
      }),
    );

  program
    .command("sync")
    .description("add every starred repository to the public staryu list")
    .action(
      guard(async (_options: unknown, command: Command) => {
        await syncCommand({ debug: debugOf(command) });
      }),
    );

  program
    .command("undo")
    .description("reverse the actions of the most recent apply run")
    .option("-y, --yes", "undo without prompting")
    .action(
      guard(async (options: { yes?: boolean }, command: Command) => {
        await undoCommand({ yes: options.yes, debug: debugOf(command) });
      }),
    );

  program
    .command("status")
    .description("show config, token, list and database state")
    .action(
      guard(async (_options: unknown, command: Command) => {
        await statusCommand({ debug: debugOf(command) });
      }),
    );

  program.action(() => {
    program.help();
  });

  return program;
}
