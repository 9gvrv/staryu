import type { DatabaseSync } from "node:sqlite";
import type { GitHubList, RepoRecord } from "../types.ts";
import type { StaryuConfig } from "./config.ts";
import type { RestApi } from "../github/rest.ts";
import type { GraphQLApi } from "../github/graphql.ts";
import {
  getRepoById,
  markRepoListAdded,
  markRepoStarred,
  recordAction,
  updateCandidate,
} from "./db.ts";
import { ensureStaryuList, unionListIds } from "./lists.ts";

export interface ApplyDeps {
  rest: RestApi;
  graphql: GraphQLApi;
  db: DatabaseSync;
  config: StaryuConfig;
  runId: number;
  discoverRunId: number;
  onProgress?: (message: string) => void;
}

export interface ApplyResult {
  list: GitHubList;
  starred: number;
  alreadyStarred: number;
  addedToList: number;
  failures: Array<{ repo: RepoRecord; error: string }>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function starMessage(error: unknown): string {
  const message = messageOf(error);
  if (/resource not accessible|forbidden/i.test(message)) {
    return `${message}. Your token needs write permission to star repositories (classic token: repo or public_repo).`;
  }
  return message;
}

function listMessage(error: unknown): string {
  const message = messageOf(error);
  if (/resource not accessible|forbidden/i.test(message)) {
    return `${message}. Your token needs permission to modify GitHub lists (classic token: repo or public_repo plus user).`;
  }
  return message;
}

export async function applyRepos(
  deps: ApplyDeps,
  repos: RepoRecord[],
): Promise<ApplyResult> {
  const { rest, graphql, db, runId, discoverRunId } = deps;

  const list = await ensureStaryuList(graphql, deps.config);
  const membership = await graphql.getListMembershipMap();

  let starred = 0;
  let alreadyStarred = 0;
  let addedToList = 0;
  const failures: ApplyResult["failures"] = [];

  for (const repo of repos) {
    deps.onProgress?.(`Processing ${repo.fullName}`);

    let starredNow = false;
    try {
      const liveStarred = await rest.isStarred(repo.owner, repo.name);
      if (liveStarred) {
        alreadyStarred += 1;
        const stored = getRepoById(db, repo.id);
        if (!stored || stored.starredVia === "unknown") {
          markRepoStarred(db, repo.nodeId, "user");
        }
      } else {
        await rest.star(repo.owner, repo.name);
        recordAction(db, runId, repo.id, "star", { starred: false }, { starred: true }, true);
        markRepoStarred(db, repo.nodeId, "tool");
        starred += 1;
        starredNow = true;
      }
    } catch (error) {
      const message = starMessage(error);
      recordAction(
        db,
        runId,
        repo.id,
        "star",
        { starred: false },
        { starred: false },
        false,
        message,
      );
      updateCandidate(db, discoverRunId, repo.id, { outcome: "failed", error: message });
      failures.push({ repo, error: `star failed: ${message}` });
      continue;
    }

    try {
      const currentListIds = membership.get(repo.nodeId) ?? [];
      if (!currentListIds.includes(list.id)) {
        const nextListIds = unionListIds(currentListIds, list.id);
        await graphql.updateListsForItem(repo.nodeId, nextListIds);
        recordAction(
          db,
          runId,
          repo.id,
          "list_add",
          { listIds: currentListIds },
          { listIds: nextListIds },
          true,
        );
        membership.set(repo.nodeId, nextListIds);
        markRepoListAdded(db, repo.nodeId, "tool");
        addedToList += 1;
      }
    } catch (error) {
      const message = listMessage(error);
      recordAction(
        db,
        runId,
        repo.id,
        "list_add",
        { listIds: membership.get(repo.nodeId) ?? [] },
        { listIds: membership.get(repo.nodeId) ?? [] },
        false,
        message,
      );
      failures.push({ repo, error: `list add failed: ${message}` });
      updateCandidate(db, discoverRunId, repo.id, {
        outcome: starredNow ? "starred" : "already_starred",
        error: message,
      });
      continue;
    }

    updateCandidate(db, discoverRunId, repo.id, {
      outcome: starredNow ? "starred" : "already_starred",
      error: null,
    });
  }

  return { list, starred, alreadyStarred, addedToList, failures };
}
