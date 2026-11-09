import type { DatabaseSync } from "node:sqlite";
import type { GitHubList } from "../types.ts";
import type { StaryuConfig } from "./config.ts";
import type { RestApi } from "../github/rest.ts";
import type { GraphQLApi } from "../github/graphql.ts";
import {
  markRepoListAdded,
  markRepoUnstarred,
  recordAction,
  upsertRepo,
  getRepoById,
  listStarredRepos,
} from "./db.ts";
import { ensureStaryuList, unionListIds } from "./lists.ts";
import { repoFromSearch } from "./mapper.ts";

export interface SyncDeps {
  rest: RestApi;
  graphql: GraphQLApi;
  db: DatabaseSync;
  config: StaryuConfig;
  runId: number;
  onProgress?: (message: string) => void;
}

export interface SyncResult {
  list: GitHubList;
  totalStars: number;
  alreadyListed: number;
  added: number;
  failures: Array<{ repo: string; error: string }>;
}

const BATCH_SIZE = 20;

/**
 * Add every starred repository to the public `staryu` list. This never unstars
 * anything and preserves membership in the user's other lists.
 */
export async function syncStars(deps: SyncDeps): Promise<SyncResult> {
  const { rest, graphql, db, runId } = deps;

  const list = await ensureStaryuList(graphql, deps.config);

  deps.onProgress?.("Fetching starred repositories");
  const starred = await rest.listStarredAll({
    onPage: (page, pageRepos) =>
      deps.onProgress?.(`Fetched page ${page} (${pageRepos.length} repositories)`),
  });

  // Reconcile stars the user removed by hand so discovery can offer them again.
  const currentStarIds = new Set(starred.map((repo) => repo.id));
  for (const known of listStarredRepos(db)) {
    if (!currentStarIds.has(known.id)) {
      markRepoUnstarred(db, known.nodeId);
    }
  }

  const repos = starred.map((repo) => {
    const existing = getRepoById(db, repo.id);
    const record = repoFromSearch(repo, {
      firstSeenAt: existing?.firstSeenAt,
      lastSeenAt: new Date().toISOString(),
      listAddedVia: existing?.listAddedVia ?? "unknown",
      starredVia: existing?.starredVia && existing.starredVia !== "unknown"
        ? existing.starredVia
        : "user",
    });
    upsertRepo(db, record);
    return record;
  });

  deps.onProgress?.("Reading current list membership");
  const membership = await graphql.getListMembershipMap();

  const missing = repos.filter((repo) => !(membership.get(repo.nodeId) ?? []).includes(list.id));
  const alreadyListed = repos.length - missing.length;
  const failures: SyncResult["failures"] = [];
  let added = 0;

  for (let offset = 0; offset < missing.length; offset += BATCH_SIZE) {
    const batch = missing.slice(offset, offset + BATCH_SIZE);
    deps.onProgress?.(
      `Adding repositories to the list (${Math.min(offset + BATCH_SIZE, missing.length)}/${missing.length})`,
    );

    const items = batch.map((repo) => ({
      itemId: repo.nodeId,
      before: membership.get(repo.nodeId) ?? [],
      after: unionListIds(membership.get(repo.nodeId), list.id),
    }));

    let results: Array<{ itemId: string; success: boolean; error?: string }>;
    try {
      results = await graphql.updateListsForItems(
        items.map((item) => ({ itemId: item.itemId, listIds: item.after })),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const repo of batch) {
        failures.push({ repo: repo.fullName, error: message });
        recordAction(
          db,
          runId,
          repo.id,
          "list_add",
          { listIds: membership.get(repo.nodeId) ?? [] },
          { listIds: unionListIds(membership.get(repo.nodeId), list.id) },
          false,
          message,
        );
      }
      continue;
    }

    const resultByItem = new Map(results.map((result) => [result.itemId, result]));
    for (const item of items) {
      const repo = batch.find((entry) => entry.nodeId === item.itemId);
      if (!repo) {
        continue;
      }
      const result = resultByItem.get(item.itemId);
      if (result?.success) {
        recordAction(
          db,
          runId,
          repo.id,
          "list_add",
          { listIds: item.before },
          { listIds: item.after },
          true,
        );
        markRepoListAdded(db, repo.nodeId, "tool");
        membership.set(repo.nodeId, item.after);
        added += 1;
      } else {
        const message = result?.error ?? "GitHub did not confirm the list update.";
        failures.push({ repo: repo.fullName, error: message });
        recordAction(
          db,
          runId,
          repo.id,
          "list_add",
          { listIds: item.before },
          { listIds: item.after },
          false,
          message,
        );
      }
    }
  }

  return { list, totalStars: repos.length, alreadyListed, added, failures };
}
