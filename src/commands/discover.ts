import { createRun, finishRun, pruneRuns } from "../core/db.ts";
import { discoverCandidates } from "../core/discover.ts";
import { messageOf } from "../core/errors.ts";
import { renderCandidates } from "../ui/table.ts";
import { createProgress, p } from "../ui/prompts.ts";
import { loadSetup } from "./shared.ts";

export interface DiscoverOptions {
  debug?: boolean;
}

export async function discoverCommand(options: DiscoverOptions = {}): Promise<void> {
  p.intro("staryu discover");
  const { config, db, apis } = loadSetup({ debug: options.debug });

  const runId = createRun(db, "discover", config);
  const progress = createProgress("Starting discovery");

  try {
    const result = await discoverCandidates({
      rest: apis.rest,
      graphql: apis.graphql,
      db,
      config,
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
    p.outro("Review and star them with `staryu apply`.");
  } catch (error) {
    finishRun(db, runId, "failed", { error: messageOf(error) });
    progress.fail("Discovery failed");
    throw error;
  }
}
