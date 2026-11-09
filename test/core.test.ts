import { describe, expect, test } from "bun:test";
import type { Candidate, GitHubSearchRepo, RepoRecord } from "../src/types.ts";
import {
  defaultConfig,
  validateConfig,
} from "../src/core/config.ts";
import { buildSearchQueries } from "../src/core/search.ts";
import { filterRepo, scoreRepo } from "../src/core/score.ts";
import { inferProfile } from "../src/core/profile.ts";
import { repoFromSearch } from "../src/core/mapper.ts";
import {
  createRun,
  finishRun,
  getActions,
  getCandidates,
  getRepoById,
  markRepoStarred,
  markRepoUnstarred,
  openDatabase,
  recordAction,
  saveCandidates,
  upsertRepo,
} from "../src/core/db.ts";

function makeRepo(overrides: Partial<RepoRecord> = {}): RepoRecord {
  const now = new Date().toISOString();
  return {
    id: 1,
    nodeId: "R_kgDOtest",
    fullName: "owner/repo",
    owner: "owner",
    name: "repo",
    htmlUrl: "https://github.com/owner/repo",
    description: "A useful library",
    language: "TypeScript",
    stars: 1200,
    forks: 120,
    topics: ["typescript", "cli"],
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

describe("config", () => {
  test("defaults are valid", () => {
    const config = validateConfig(defaultConfig());
    expect(config.github.list.name).toBe("staryu");
    expect(config.preferences.stars.min).toBe(100);
    expect(config.run.maxNewStars).toBe(20);
  });

  test("rejects an inverted star range", () => {
    const config = defaultConfig();
    config.preferences.stars = { min: 500, max: 100 };
    expect(() => validateConfig(config)).toThrow();
  });

  test("merges partial config with defaults", () => {
    const config = validateConfig({ github: { list: { name: "mine" } } });
    expect(config.github.list.name).toBe("mine");
    expect(config.github.list.private).toBe(false);
  });
});

describe("search queries", () => {
  test("builds one use query and one contribution query per language", () => {
    const config = defaultConfig();
    config.preferences.languages = ["TypeScript", "Go"];
    config.run.search.maxQueries = 10;

    const queries = buildSearchQueries(config);
    expect(queries.map((query) => query.id)).toEqual([
      "lang:TypeScript",
      "lang:Go",
      "contribute:TypeScript",
      "contribute:Go",
    ]);
    expect(queries[0]?.q).toContain("language:TypeScript");
    expect(queries[0]?.q).toContain("archived:false");
    expect(queries[0]?.q).toContain("stars:100..50000");
    expect(queries[2]?.q).toContain("good-first-issues:>=1");
  });

  test("respects the query budget", () => {
    const config = defaultConfig();
    config.preferences.languages = ["TypeScript", "Go", "Rust"];
    config.run.search.maxQueries = 2;
    expect(buildSearchQueries(config)).toHaveLength(2);
  });

  test("falls back to a general query without languages", () => {
    const config = defaultConfig();
    config.preferences.languages = [];
    const queries = buildSearchQueries(config);
    expect(queries[0]?.id).toBe("general");
    expect(queries[0]?.q).not.toContain("language:");
  });
});

describe("filtering and scoring", () => {
  test("rejects archived, forked and inactive repositories", () => {
    const config = defaultConfig();
    expect(filterRepo(makeRepo({ archived: true }), config).ok).toBe(false);
    expect(filterRepo(makeRepo({ fork: true }), config).ok).toBe(false);
    expect(filterRepo(makeRepo({ pushedAt: null }), config).reason).toBe("inactive");
  });

  test("rejects awesome lists and excluded topics", () => {
    const config = defaultConfig();
    expect(filterRepo(makeRepo({ name: "awesome-tools" }), config).reason).toBe("awesome list");
    expect(
      filterRepo(makeRepo({ topics: ["awesome-list"] }), config).reason,
    ).toBe("excluded topic");
  });

  test("rejects out-of-range stars and licenses", () => {
    const config = defaultConfig();
    config.preferences.stars = { min: 1000, max: 2000 };
    expect(filterRepo(makeRepo({ stars: 50 }), config).reason).toBe("outside star range");

    config.preferences.license.required = true;
    config.preferences.license.allow = ["Apache-2.0"];
    expect(filterRepo(makeRepo({ license: "MIT" }), config).reason).toBe("license not allowed");
    expect(filterRepo(makeRepo({ license: "Apache-2.0" }), config).ok).toBe(true);
  });

  test("scores deterministically and explains why", () => {
    const config = defaultConfig();
    config.preferences.languages = ["TypeScript"];
    config.preferences.topics.include = ["cli"];

    const candidate = scoreRepo(makeRepo(), config, "use");
    const repeat = scoreRepo(makeRepo(), config, "use");

    expect(candidate.score).toBe(repeat.score);
    expect(candidate.score).toBeGreaterThan(50);
    expect(candidate.reasons.map((reason) => reason.code)).toContain("language");
    expect(candidate.reasons.map((reason) => reason.code)).toContain("good-first");
    expect(candidate.intent).toBe("both");
  });
});

describe("profile inference", () => {
  test("suggests languages, topics and a star range", () => {
    const now = new Date().toISOString();
    const repos: GitHubSearchRepo[] = [
      {
        id: 1,
        node_id: "R1",
        name: "a",
        full_name: "x/a",
        owner: { login: "x" },
        html_url: "https://github.com/x/a",
        description: null,
        language: "TypeScript",
        stargazers_count: 100,
        forks_count: 10,
        open_issues_count: 1,
        topics: ["cli"],
        license: { name: "MIT", spdx_id: "MIT" },
        pushed_at: now,
        created_at: now,
        updated_at: now,
        archived: false,
        fork: false,
      },
      {
        id: 2,
        node_id: "R2",
        name: "b",
        full_name: "x/b",
        owner: { login: "x" },
        html_url: "https://github.com/x/b",
        description: null,
        language: "TypeScript",
        stargazers_count: 400,
        forks_count: 20,
        open_issues_count: 2,
        topics: ["cli", "tools"],
        license: { name: "MIT", spdx_id: "MIT" },
        pushed_at: now,
        created_at: now,
        updated_at: now,
        archived: false,
        fork: false,
      },
    ];

    const profile = inferProfile(repos);
    expect(profile.totalStars).toBe(2);
    expect(profile.suggested.languages).toEqual(["TypeScript"]);
    expect(profile.suggested.topics).toContain("cli");
    expect(profile.suggested.starMin).toBeLessThanOrEqual(100);
    expect(profile.suggested.starMax).toBeGreaterThanOrEqual(400);
  });
});

describe("mapper", () => {
  test("maps REST search results and applies overrides", () => {
    const repo = repoFromSearch(
      {
        id: 7,
        node_id: "R7",
        name: "repo",
        full_name: "owner/repo",
        owner: { login: "owner" },
        html_url: "https://github.com/owner/repo",
        description: "hello",
        language: "Go",
        stargazers_count: 10,
        forks_count: 1,
        open_issues_count: 2,
        topics: ["go"],
        license: { name: "MIT", spdx_id: "MIT" },
        pushed_at: new Date().toISOString(),
        created_at: null,
        updated_at: null,
        archived: false,
        fork: false,
      },
      { starredVia: "user" },
    );
    expect(repo.fullName).toBe("owner/repo");
    expect(repo.license).toBe("MIT");
    expect(repo.starredVia).toBe("user");
  });
});

describe("database", () => {
  test("persists repos, candidates and actions", () => {
    const db = openDatabase(":memory:");
    const repo = makeRepo();
    upsertRepo(db, repo);
    expect(getRepoById(db, repo.id)?.fullName).toBe(repo.fullName);

    markRepoStarred(db, repo.nodeId, "tool");
    expect(getRepoById(db, repo.id)?.starredVia).toBe("tool");

    // A later discovery upsert must not erase known provenance.
    upsertRepo(db, makeRepo());
    expect(getRepoById(db, repo.id)?.starredVia).toBe("tool");

    markRepoUnstarred(db, repo.nodeId);
    expect(getRepoById(db, repo.id)?.starredVia).toBe("unknown");

    const runId = createRun(db, "discover", defaultConfig());
    const candidate: Candidate = {
      repo,
      score: 42,
      reasons: [{ code: "language", label: "TypeScript", points: 25 }],
      intent: "use",
      sourceIntent: "use",
    };
    saveCandidates(db, runId, [candidate]);
    const candidates = getCandidates(db, runId);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.score).toBe(42);
    expect(candidates[0]?.repo.fullName).toBe(repo.fullName);

    recordAction(db, runId, repo.id, "star", { starred: false }, { starred: true }, true);
    const actions = getActions(db, runId);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.action).toBe("star");
    expect(actions[0]?.success).toBe(true);

    finishRun(db, runId, "completed", { ok: true });
    db.close();
  });
});
