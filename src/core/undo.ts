import type { DatabaseSync } from "node:sqlite";
import type { StaryuConfig } from "./config.ts";
import type { RestApi } from "../github/rest.ts";
import type { GraphQLApi } from "../github/graphql.ts";
import {
  getActions,
  getRepoById,
  markRepoListRemoved,
  markRepoUnstarred,
  recordAction,
} from "./db.ts";
import { asStringArray, findStaryuList } from "./lists.ts";

export interface UndoDeps {
  rest: RestApi;
  graphql: GraphQLApi;
  db: DatabaseSync;
  config: StaryuConfig;
  /** Run that records the undo operations. */
  runId: number;
  /** Apply run being reversed. */
  targetRunId: number;
  onProgress?: (message: string) => void;
}

export interface UndoResult {
  removedFromList: number;
  unstarred: number;
  skipped: number;
  failures: Array<{ repo: string; error: string }>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function beforeListIds(value: unknown): string[] {
  if (value && typeof value === "object" && "listIds" in value) {
    return asStringArray((value as { listIds?: unknown }).listIds);
  }
  return [];
}

function beforeStarred(value: unknown): boolean | null {
  if (value && typeof value === "object" && "starred" in value) {
    const starred = (value as { starred?: unknown }).starred;
    return typeof starred === "boolean" ? starred : null;
  }
  return null;
}

/**
 * Reverse a previous apply run. Only actions recorded as successful are
 * considered, list removals happen before unstarring, and a repository is only
 * unstared when staryu originally starred it and it is still starred now.
 */
export async function undoApply(deps: UndoDeps): Promise<UndoResult> {
  const { rest, graphql, db, runId, targetRunId } = deps;

  const list = await findStaryuList(graphql, deps.config);
  const membership = list ? await graphql.getListMembershipMap() : new Map<string, string[]>();
  const actions = getActions(db, targetRunId).slice().reverse();

  const result: UndoResult = { removedFromList: 0, unstarred: 0, skipped: 0, failures: [] };

  for (const action of actions) {
    if (!action.success) {
      result.skipped += 1;
      continue;
    }

    const repo = getRepoById(db, action.repoId);
    if (!repo) {
      result.skipped += 1;
      continue;
    }
    deps.onProgress?.(`Undoing ${action.action.replace("_", " ")} for ${repo.fullName}`);

    if (action.action === "list_add") {
      if (!list) {
        result.skipped += 1;
        continue;
      }
      const before = beforeListIds(action.before);
      if (before.includes(list.id)) {
        result.skipped += 1;
        continue;
      }
      const current = membership.get(repo.nodeId) ?? [];
      if (!current.includes(list.id)) {
        result.skipped += 1;
        continue;
      }
      const next = current.filter((id) => id !== list.id);
      try {
        await graphql.updateListsForItem(repo.nodeId, next);
        recordAction(
          db,
          runId,
          repo.id,
          "list_remove",
          { listIds: current },
          { listIds: next },
          true,
        );
        membership.set(repo.nodeId, next);
        markRepoListRemoved(db, repo.nodeId);
        result.removedFromList += 1;
      } catch (error) {
        const message = messageOf(error);
        recordAction(
          db,
          runId,
          repo.id,
          "list_remove",
          { listIds: current },
          { listIds: next },
          false,
          message,
        );
        result.failures.push({ repo: repo.fullName, error: message });
      }
      continue;
    }

    if (action.action === "star") {
      if (beforeStarred(action.before) !== false) {
        result.skipped += 1;
        continue;
      }
      const stored = getRepoById(db, repo.id);
      if (!stored || stored.starredVia !== "tool") {
        result.skipped += 1;
        continue;
      }
      try {
        const liveStarred = await rest.isStarred(repo.owner, repo.name);
        if (!liveStarred) {
          result.skipped += 1;
          continue;
        }
        await rest.unstar(repo.owner, repo.name);
        recordAction(
          db,
          runId,
          repo.id,
          "unstar",
          { starred: true },
          { starred: false },
          true,
        );
        markRepoUnstarred(db, repo.nodeId);
        result.unstarred += 1;
      } catch (error) {
        const message = messageOf(error);
        recordAction(
          db,
          runId,
          repo.id,
          "unstar",
          { starred: true },
          { starred: false },
          false,
          message,
        );
        result.failures.push({ repo: repo.fullName, error: message });
      }
    }
  }

  return result;
}
