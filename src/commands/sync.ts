import { createRun, finishRun } from "../core/db.ts";
import { syncStars } from "../core/sync.ts";
import { messageOf } from "../core/errors.ts";
import { createProgress, p } from "../ui/prompts.ts";
import { loadSetup } from "./shared.ts";

export interface SyncOptions {
  debug?: boolean;
}

export async function syncCommand(options: SyncOptions = {}): Promise<void> {
  p.intro("staryu sync");
  const { config, db, apis } = loadSetup({ debug: options.debug });

  const runId = createRun(db, "sync", config);
  const progress = createProgress("Syncing stars");

  try {
    const result = await syncStars({
      rest: apis.rest,
      graphql: apis.graphql,
      db,
      config,
      runId,
      onProgress: progress.update,
    });

    finishRun(db, runId, result.failures.length > 0 ? "partial" : "completed", {
      list: result.list,
      totalStars: result.totalStars,
      alreadyListed: result.alreadyListed,
      added: result.added,
      failures: result.failures,
    });

    progress.stop(
      result.failures.length > 0
        ? `Processed ${result.totalStars} stars: ${result.added} added, ${result.failures.length} failed`
        : `"${result.list.name}" contains all ${result.totalStars} starred repositories`,
    );

    if (result.list.isPrivate !== config.github.list.private) {
      p.log.warn(
        `List "${result.list.name}" is ${result.list.isPrivate ? "private" : "public"}, but the config expects ${config.github.list.private ? "private" : "public"}. Change it on GitHub if needed.`,
      );
    }

    for (const failure of result.failures) {
      p.log.warn(`${failure.repo}: ${failure.error}`);
    }

    p.outro("Sync complete.");
  } catch (error) {
    finishRun(db, runId, "failed", { error: messageOf(error) });
    progress.fail("Sync failed");
    throw error;
  }
}
