import type { CandidateWithRepo } from "../types.ts";
import { createRun, finishRun, getCandidates, getLatestRun, getRun } from "../core/db.ts";
import { applyRepos } from "../core/apply.ts";
import { messageOf, UserError } from "../core/errors.ts";
import { formatNumber, intentLabel, renderCandidates } from "../ui/table.ts";
import { createProgress, ensure, p } from "../ui/prompts.ts";
import { loadSetup } from "./shared.ts";

export interface ApplyOptions {
  debug?: boolean;
  yes?: boolean;
  runId?: number;
  /** Populated by discover --apply to reuse the fresh run. */
  candidates?: CandidateWithRepo[];
  discoverRunId?: number;
}

export async function applyCommand(options: ApplyOptions = {}): Promise<void> {
  p.intro("staryu apply");
  const { config, db, apis } = loadSetup({ debug: options.debug });

  let discoverRunId = options.discoverRunId;
  let candidates = options.candidates;

  if (!candidates) {
    const discoverRun = options.runId
      ? getRun(db, options.runId)
      : getLatestRun(db, { commands: ["discover"], statuses: ["completed", "partial"] });
    if (!discoverRun) {
      throw new UserError("No discovery run found. Run `staryu discover` first.");
    }
    discoverRunId = discoverRun.id;
    candidates = getCandidates(db, discoverRun.id).filter(
      (candidate) => candidate.outcome === "pending",
    );
  }

  if (!candidates || candidates.length === 0) {
    p.log.info("No pending candidates. Run `staryu discover` to find more.");
    p.outro("Nothing to apply.");
    return;
  }
  if (discoverRunId === undefined) {
    throw new UserError("Missing discovery run for these candidates.");
  }

  console.log("");
  console.log(renderCandidates(candidates));
  console.log("");

  const defaultSelection = candidates
    .slice(0, config.run.maxNewStars)
    .map((candidate) => candidate.repo.id);

  let selectedIds: number[];
  if (options.yes) {
    selectedIds = defaultSelection;
  } else {
    const selected = ensure(
      await p.multiselect<number>({
        message: `Select repositories to star (${config.run.maxNewStars} preselected, space to toggle)`,
        options: candidates.map((candidate) => ({
          value: candidate.repo.id,
          label: candidate.repo.fullName,
          hint: `score ${candidate.score} · ${formatNumber(candidate.repo.stars)} stars · ${intentLabel(candidate.intent)}`,
        })),
        initialValues: defaultSelection,
        required: true,
      }),
    );
    selectedIds = selected as number[];
  }

  const chosen = candidates.filter((candidate) => selectedIds.includes(candidate.repo.id));
  if (chosen.length === 0) {
    p.log.info("Nothing selected.");
    p.outro("No changes made.");
    return;
  }

  if (!options.yes) {
    const confirmed = ensure(
      await p.confirm({
        message: `Star ${chosen.length} repositor${chosen.length === 1 ? "y" : "ies"} and add them to the "${config.github.list.name}" list?`,
        initialValue: true,
      }),
    );
    if (!confirmed) {
      p.outro("No changes made.");
      return;
    }
  }

  const runId = createRun(db, "apply", config);
  const progress = createProgress("Applying changes");

  try {
    const result = await applyRepos(
      {
        rest: apis.rest,
        graphql: apis.graphql,
        db,
        config,
        runId,
        discoverRunId,
        onProgress: progress.update,
      },
      chosen.map((candidate) => candidate.repo),
    );

    finishRun(db, runId, result.failures.length > 0 ? "partial" : "completed", {
      list: result.list,
      starred: result.starred,
      alreadyStarred: result.alreadyStarred,
      addedToList: result.addedToList,
      failures: result.failures.map((failure) => ({
        repo: failure.repo.fullName,
        error: failure.error,
      })),
    });

    progress.stop(
      `Starred ${result.starred}, already starred ${result.alreadyStarred}, added ${result.addedToList} to "${result.list.name}"`,
    );

    if (result.list.isPrivate !== config.github.list.private) {
      p.log.warn(
        `List "${result.list.name}" is ${result.list.isPrivate ? "private" : "public"}, but the config expects ${config.github.list.private ? "private" : "public"}. Change it on GitHub if needed.`,
      );
    }

    for (const failure of result.failures) {
      p.log.warn(`${failure.repo.fullName}: ${failure.error}`);
    }

    p.log.info(`Run ${runId} recorded. Undo with \`staryu undo\` if needed.`);
    p.outro("Done.");
  } catch (error) {
    finishRun(db, runId, "failed", { error: messageOf(error) });
    progress.fail("Apply failed");
    throw error;
  }
}
