import type { DatabaseSync } from "node:sqlite";
import type { Candidate, CandidateWithRepo, RepoRecord } from "../types.ts";
import type { StaryuConfig } from "./config.ts";
import type { RestApi } from "../github/rest.ts";
import type { GraphQLApi } from "../github/graphql.ts";
import { repoFromSearch, mergeEnriched } from "./mapper.ts";
import {
  getCandidates,
  getRepoById,
  getRepoByNodeId,
  markRepoStarred,
  saveCandidates,
  updateRepoEnrichment,
  upsertRepo,
} from "./db.ts";
import { runSearch } from "./search.ts";
import { filterRepo, scoreRepo } from "./score.ts";

export interface DiscoverDeps {
  rest: RestApi;
  graphql: GraphQLApi;
  db: DatabaseSync;
  config: StaryuConfig;
  runId: number;
  onProgress?: (message: string) => void;
}

export interface DiscoverResult {
  candidates: CandidateWithRepo[];
  fetched: number;
  evaluated: number;
  enriched: number;
  errors: string[];
  queries: string[];
}

/**
 * Search, filter, enrich and score repositories. Repositories are persisted
 * before scoring so the audit trail exists even if the user never stars them.
 */
export async function discoverCandidates(deps: DiscoverDeps): Promise<DiscoverResult> {
  const { rest, graphql, db, config, runId } = deps;

  deps.onProgress?.("Searching GitHub");
  const search = await runSearch({ rest, config, onProgress: deps.onProgress });
  const errors = [...search.errors];

  const now = new Date().toISOString();
  const pool: Array<{ repo: RepoRecord; sourceIntent: Candidate["sourceIntent"] }> = [];

  for (const { repo: searchRepo, sourceIntent } of search.repos.values()) {
    const existing = getRepoById(db, searchRepo.id) ?? getRepoByNodeId(db, searchRepo.node_id);
    const repo = repoFromSearch(searchRepo, {
      firstSeenAt: existing?.firstSeenAt ?? now,
      starredVia: existing?.starredVia ?? "unknown",
      listAddedVia: existing?.listAddedVia ?? "unknown",
    });

    // Persist metadata for every discovered repository, filtered or not.
    upsertRepo(db, repo);

    if (repo.starredVia !== "unknown") {
      continue;
    }
    if (!filterRepo(repo, config, { preEnrich: true }).ok) {
      continue;
    }
    pool.push({ repo, sourceIntent });
  }

  // Enrich the most promising candidates first. Preliminary scores use only
  // REST search metadata; the final ranking happens after enrichment.
  const preliminary = pool
    .map((entry) => scoreRepo(entry.repo, config, entry.sourceIntent))
    .sort((a, b) => b.score - a.score);

  const enrichTargets = preliminary
    .slice(0, Math.min(preliminary.length, config.run.candidatePool + 10))
    .map((candidate) => ({
      id: candidate.repo.id,
      nodeId: candidate.repo.nodeId,
      owner: candidate.repo.owner,
      name: candidate.repo.name,
    }));

  const enrichedById = new Map<number, RepoRecord>();
  if (config.run.enrich.enabled && enrichTargets.length > 0) {
    deps.onProgress?.(`Enriching ${enrichTargets.length} repositories`);
    try {
      const enrichment = await graphql.enrichRepositories(
        enrichTargets,
        config.preferences.contribution.labels,
        { deep: config.run.enrich.deep, batchSize: config.run.enrich.batchSize },
      );
      errors.push(...enrichment.errors);
      for (const candidate of preliminary) {
        const data = enrichment.repos.get(candidate.repo.nodeId);
        if (!data) {
          continue;
        }
        const merged = mergeEnriched(candidate.repo, data);
        if (data.viewerHasStarred && merged.starredVia === "unknown") {
          merged.starredVia = "user";
          markRepoStarred(db, merged.nodeId, "user");
        }
        updateRepoEnrichment(db, merged);
        enrichedById.set(merged.id, merged);
      }
    } catch (error) {
      errors.push(
        `Enrichment failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  deps.onProgress?.("Scoring candidates");
  const scored: Candidate[] = [];
  for (const entry of preliminary) {
    const repo = enrichedById.get(entry.repo.id) ?? entry.repo;
    if (repo.starredVia !== "unknown") {
      continue;
    }
    if (!filterRepo(repo, config).ok) {
      continue;
    }
    scored.push(scoreRepo(repo, config, entry.sourceIntent));
  }

  scored.sort((a, b) => b.score - a.score || b.repo.stars - a.repo.stars);
  const selected = scored.slice(0, config.run.candidatePool);

  saveCandidates(db, runId, selected);

  return {
    candidates: getCandidates(db, runId),
    fetched: search.totalFetched,
    evaluated: pool.length,
    enriched: enrichedById.size,
    errors,
    queries: search.queries.map((query) => query.id),
  };
}
