import type { AppPaths } from "../core/paths.ts";
import type { StaryuConfig } from "../core/config.ts";
import { saveConfig } from "../core/config.ts";
import { createRun, finishRun, pruneRuns } from "../core/db.ts";
import { discoverCandidates } from "../core/discover.ts";
import { messageOf, UserError } from "../core/errors.ts";
import { cliCommand } from "../core/invocation.ts";
import { renderCandidates } from "../ui/table.ts";
import { createProgress, ensure, isInteractive, p } from "../ui/prompts.ts";
import { applyPreferences, describePreferences, promptPreferences } from "./preferences.ts";
import { loadSetup } from "./shared.ts";

export interface DiscoverOptions {
  debug?: boolean;
  /** Use the saved preferences without asking. */
  reuse?: boolean;
  /** Always open the preference prompts before searching. */
  customize?: boolean;
}

async function resolvePreferences(
  config: StaryuConfig,
  paths: AppPaths,
  options: DiscoverOptions,
): Promise<StaryuConfig> {
  if (options.reuse && options.customize) {
    throw new UserError("Use either --reuse or --customize, not both.");
  }

  const interactive = isInteractive();
  if (!interactive) {
    if (options.customize) {
      throw new UserError("--customize needs an interactive terminal.");
    }
    return config;
  }

  if (options.reuse) {
    return config;
  }

  let customize = options.customize === true;
  if (!customize) {
    const choice = ensure(
      await p.select<"saved" | "customize">({
        message: "Start exploring with your saved preferences?",
        options: [
          {
            value: "saved",
            label: "Yes, use saved preferences",
            hint: describePreferences(config),
          },
          {
            value: "customize",
            label: "No, customize languages, stars and activity",
          },
        ],
        initialValue: "saved",
      }),
    );
    customize = choice === "customize";
  }

  if (!customize) {
    return config;
  }

  const updated = applyPreferences(config, await promptPreferences(config));
  saveConfig(updated);
  p.log.success(`Saved preferences to ${paths.configFile}`);
  return updated;
}

export async function discoverCommand(options: DiscoverOptions = {}): Promise<void> {
  p.intro("staryu discover");
  const { config, paths, db, apis } = loadSetup({ debug: options.debug });

  const runConfig = await resolvePreferences(config, paths, options);

  const runId = createRun(db, "discover", runConfig);
  const progress = createProgress("Starting discovery");

  try {
    const result = await discoverCandidates({
      rest: apis.rest,
      graphql: apis.graphql,
      db,
      config: runConfig,
      runId,
      onProgress: progress.update,
    });

    finishRun(db, runId, result.errors.length > 0 ? "partial" : "completed", {
      fetched: result.fetched,
      evaluated: result.evaluated,
      enriched: result.enriched,
      candidates: result.candidates.length,
      queries: result.queries,
      errors: result.errors,
    });
    pruneRuns(db, 30);

    progress.stop(
      `Fetched ${result.fetched} results, evaluated ${result.evaluated}, selected ${result.candidates.length}`,
    );

    if (result.errors.length > 0) {
      p.log.warn(`${result.errors.length} discovery warning(s); first: ${result.errors[0]}`);
    }

    if (result.candidates.length === 0) {
      p.log.info(
        "No new repositories matched your preferences. Try widening the star range or languages in the config.",
      );
      p.outro("Nothing to review.");
      return;
    }

    console.log("");
    console.log(renderCandidates(result.candidates));
    console.log("");
    p.log.info(`Run ${runId} saved ${result.candidates.length} candidates.`);
    p.outro(`Review and star them with \`${cliCommand("apply")}\`.`);
  } catch (error) {
    finishRun(db, runId, "failed", { error: messageOf(error) });
    progress.fail("Discovery failed");
    throw error;
  }
}
