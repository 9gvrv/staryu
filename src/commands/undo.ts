import {
  createRun,
  finishRun,
  getActions,
  getLatestRun,
  markRunUndone,
} from "../core/db.ts";
import { undoApply } from "../core/undo.ts";
import { messageOf, UserError } from "../core/errors.ts";
import { createProgress, ensure, p } from "../ui/prompts.ts";
import { loadSetup } from "./shared.ts";

export interface UndoOptions {
  debug?: boolean;
  yes?: boolean;
}

export async function undoCommand(options: UndoOptions = {}): Promise<void> {
  p.intro("staryu undo");
  const { config, db, apis } = loadSetup({ debug: options.debug });

  const applyRun = getLatestRun(db, { commands: ["apply"] });
  if (!applyRun) {
    throw new UserError("No apply run to undo.");
  }
  if (applyRun.status === "undone") {
    p.log.info(`The latest apply run (#${applyRun.id}) is already undone.`);
    p.outro("Nothing to undo.");
    return;
  }
  if (applyRun.status === "running") {
    throw new UserError(`Apply run ${applyRun.id} never finished; refusing to guess what to undo.`);
  }

  const actions = getActions(db, applyRun.id);
  const starActions = actions.filter((action) => action.action === "star" && action.success);
  const listAdds = actions.filter((action) => action.action === "list_add" && action.success);

  if (starActions.length === 0 && listAdds.length === 0) {
    p.log.info(`Apply run ${applyRun.id} has no successful actions to undo.`);
    p.outro("Nothing to undo.");
    return;
  }

  p.log.info(
    `Run ${applyRun.id} from ${applyRun.startedAt} starred ${starActions.length} and listed ${listAdds.length}.`,
  );

  if (!options.yes) {
    const confirmed = ensure(
      await p.confirm({
        message: `Undo run ${applyRun.id}? Only repositories starred by staryu will be unstared.`,
        initialValue: false,
      }),
    );
    if (!confirmed) {
      p.outro("No changes made.");
      return;
    }
  }

  const runId = createRun(db, "undo", config);
  const progress = createProgress(`Undoing run ${applyRun.id}`);

  try {
    const result = await undoApply({
      rest: apis.rest,
      graphql: apis.graphql,
      db,
      config,
      runId,
      targetRunId: applyRun.id,
      onProgress: progress.update,
    });

    finishRun(db, runId, result.failures.length > 0 ? "partial" : "completed", {
      targetRunId: applyRun.id,
      ...result,
    });
    if (result.failures.length === 0) {
      markRunUndone(db, applyRun.id);
    }

    progress.stop(
      `Removed ${result.removedFromList} from the list, unstared ${result.unstarred}, skipped ${result.skipped}`,
    );

    for (const failure of result.failures) {
      p.log.warn(`${failure.repo}: ${failure.error}`);
    }

    if (result.failures.length > 0) {
      p.log.warn(`Run ${applyRun.id} remains undoable because some operations failed.`);
    }

    p.outro("Undo complete.");
  } catch (error) {
    finishRun(db, runId, "failed", { error: messageOf(error), targetRunId: applyRun.id });
    progress.fail("Undo failed");
    throw error;
  }
}
