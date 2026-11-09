import { describe, expect, test } from "bun:test";
import type { GitHubList, GitHubSearchRepo, RepoRecord } from "../src/types.ts";
import { defaultConfig } from "../src/core/config.ts";
import {
  createRun,
  finishRun,
  getActions,
  getCandidates,
  getRepoById,
  openDatabase,
  saveCandidates,
  upsertRepo,
} from "../src/core/db.ts";
import { applyRepos } from "../src/core/apply.ts";
import { undoApply } from "../src/core/undo.ts";
import { syncStars } from "../src/core/sync.ts";
import type { RestApi } from "../src/github/rest.ts";
import type { GraphQLApi } from "../src/github/graphql.ts";

function makeRepo(overrides: Partial<RepoRecord> = {}): RepoRecord {
  const now = new Date().toISOString();
  return {
    id: 1,
    nodeId: "R1",
    fullName: "owner/repo",
    owner: "owner",
    name: "repo",
    htmlUrl: "https://github.com/owner/repo",
    description: "A useful library",
    language: "TypeScript",
    stars: 1200,
    forks: 120,
    topics: ["typescript"],
    license: "MIT",
    pushedAt: now,
    createdAt: now,
    updatedAt: now,
    archived: false,
    fork: false,
    disabled: false,
    hasIssues: true,
    openIssues: 12,
    goodFirstIssues: 3,
    helpWantedIssues: 2,
    firstTimersIssues: 1,
    upForGrabsIssues: 1,
    contributingGuide: true,
    recentOutsiderMergedPrs: 2,
    starredVia: "unknown",
    listAddedVia: "unknown",
    firstSeenAt: now,
    lastSeenAt: now,
    lastActionAt: null,
    ...overrides,
  };
}

function searchRepo(id: number, fullName: string): GitHubSearchRepo {
  const [owner, name] = fullName.split("/") as [string, string];
  return {
    id,
    node_id: `R${id}`,
    name,
    full_name: fullName,
    owner: { login: owner },
    html_url: `https://github.com/${fullName}`,
    description: null,
    language: "TypeScript",
    stargazers_count: 100,
    forks_count: 2,
    open_issues_count: 1,
    topics: [],
    license: { name: "MIT", spdx_id: "MIT" },
    pushed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    archived: false,
    fork: false,
  };
}

function fakeApis() {
  const list: GitHubList = {
    id: "L1",
    name: "staryu",
    slug: "staryu",
    description: null,
    isPrivate: false,
    itemCount: 0,
  };
  const listMembership = new Map<string, string[]>();
  const starred = new Set<string>();
  const ids = new Map<string, number>();
  const idFor = (fullName: string): number => {
    const existing = ids.get(fullName);
    if (existing !== undefined) {
      return existing;
    }
    const id = 100 + ids.size;
    ids.set(fullName, id);
    return id;
  };

  const rest = {
    isStarred: async (owner: string, name: string) => starred.has(`${owner}/${name}`),
    star: async (owner: string, name: string) => {
      starred.add(`${owner}/${name}`);
    },
    unstar: async (owner: string, name: string) => {
      starred.delete(`${owner}/${name}`);
    },
    listStarredAll: async () =>
      [...starred].map((fullName) => searchRepo(idFor(fullName), fullName)),
  } as unknown as RestApi;

  const graphql = {
    getLists: async () => [list],
    getListMembershipMap: async () =>
      new Map([...listMembership.entries()].map(([key, value]) => [key, [...value]])),
    updateListsForItem: async (itemId: string, listIds: string[]) => {
      listMembership.set(itemId, [...listIds]);
      return { itemId, listIds };
    },
    updateListsForItems: async (items: Array<{ itemId: string; listIds: string[] }>) => {
      for (const item of items) {
        listMembership.set(item.itemId, [...item.listIds]);
      }
      return items.map((item) => ({ itemId: item.itemId, success: true }));
    },
    createList: async () => list,
  } as unknown as GraphQLApi;

  return { rest, graphql, list, listMembership, starred };
}

describe("apply and undo flow", () => {
  test("stars, lists, records actions, then reverses them", async () => {
    const db = openDatabase(":memory:");
    const config = defaultConfig();
    const repo = makeRepo();
    upsertRepo(db, repo);

    const discoverRun = createRun(db, "discover", config);
    saveCandidates(db, discoverRun, [
      {
        repo,
        score: 80,
        reasons: [{ code: "language", label: "TypeScript", points: 25 }],
        intent: "use",
        sourceIntent: "use",
      },
    ]);
    const applyRun = createRun(db, "apply", config);
    const { rest, graphql, listMembership, starred } = fakeApis();

    const applied = await applyRepos(
      { rest, graphql, db, config, runId: applyRun, discoverRunId: discoverRun },
      [repo],
    );

    expect(applied.starred).toBe(1);
    expect(applied.addedToList).toBe(1);
    expect(starred.has("owner/repo")).toBe(true);
    expect(listMembership.get("R1")).toEqual(["L1"]);
    expect(getRepoById(db, repo.id)?.starredVia).toBe("tool");
    expect(getRepoById(db, repo.id)?.listAddedVia).toBe("tool");
    expect(getCandidates(db, discoverRun)[0]?.outcome).toBe("starred");
    expect(getActions(db, applyRun).map((action) => action.action)).toEqual([
      "star",
      "list_add",
    ]);

    const undoRun = createRun(db, "undo", config);
    const undone = await undoApply({
      rest,
      graphql,
      db,
      config,
      runId: undoRun,
      targetRunId: applyRun,
    });

    expect(undone.removedFromList).toBe(1);
    expect(undone.unstarred).toBe(1);
    expect(starred.has("owner/repo")).toBe(false);
    expect(listMembership.get("R1")).toEqual([]);
    expect(getRepoById(db, repo.id)?.starredVia).toBe("unknown");
    expect(getRepoById(db, repo.id)?.listAddedVia).toBe("unknown");
  });

  test("never unstars a repository the user starred before staryu", async () => {
    const db = openDatabase(":memory:");
    const config = defaultConfig();
    const repo = makeRepo();
    upsertRepo(db, repo);

    const discoverRun = createRun(db, "discover", config);
    saveCandidates(db, discoverRun, [
      {
        repo,
        score: 50,
        reasons: [],
        intent: "use",
        sourceIntent: "use",
      },
    ]);
    const applyRun = createRun(db, "apply", config);
    const { rest, graphql, starred } = fakeApis();
    starred.add("owner/repo");

    const applied = await applyRepos(
      { rest, graphql, db, config, runId: applyRun, discoverRunId: discoverRun },
      [repo],
    );
    expect(applied.alreadyStarred).toBe(1);
    expect(getRepoById(db, repo.id)?.starredVia).toBe("user");

    const undoRun = createRun(db, "undo", config);
    const undone = await undoApply({
      rest,
      graphql,
      db,
      config,
      runId: undoRun,
      targetRunId: applyRun,
    });

    expect(undone.unstarred).toBe(0);
    expect(starred.has("owner/repo")).toBe(true);
  });
});

describe("sync flow", () => {
  test("adds every star to the list and records actions", async () => {
    const db = openDatabase(":memory:");
    const config = defaultConfig();
    const { rest, graphql, listMembership, starred } = fakeApis();
    starred.add("a/one");
    starred.add("b/two");

    const runId = createRun(db, "sync", config);
    const result = await syncStars({ rest, graphql, db, config, runId });

    expect(result.totalStars).toBe(2);
    expect(result.added).toBe(2);
    expect(result.failures).toHaveLength(0);
    const nodeIds = [...listMembership.keys()].sort();
    expect(nodeIds).toEqual(["R100", "R101"]);
    expect(getActions(db, runId)).toHaveLength(2);
    finishRun(db, runId, "completed", result);

    // Running again is idempotent.
    const secondRun = createRun(db, "sync", config);
    const second = await syncStars({ rest, graphql, db, config, runId: secondRun });
    expect(second.alreadyListed).toBe(2);
    expect(second.added).toBe(0);

    // A star removed by hand is reconciled so discovery can offer it again.
    starred.delete("a/one");
    starred.add("c/three");
    const thirdRun = createRun(db, "sync", config);
    const third = await syncStars({ rest, graphql, db, config, runId: thirdRun });
    expect(third.totalStars).toBe(2);
    expect(third.added).toBe(1);
    expect(getRepoById(db, 100)?.starredVia).toBe("unknown");
    expect(getRepoById(db, 102)?.starredVia).toBe("user");
  });
});
