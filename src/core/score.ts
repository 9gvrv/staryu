import type { Candidate, Intent, RepoReason, RepoRecord } from "../types.ts";
import type { StaryuConfig } from "./config.ts";

export interface FilterResult {
  ok: boolean;
  reason: string | null;
}

function daysSince(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return null;
  }
  return Math.max(0, Math.round((Date.now() - timestamp) / 86_400_000));
}

const AWESOME_NAME_PATTERN = /^awesome([-_.]|$)|awesome[-_ ]list/i;
const AWESOME_DESCRIPTION_PATTERN = /awesome[- ]list|curated list of awesome/i;

function hasAwesomeMarker(repo: RepoRecord): boolean {
  return (
    AWESOME_NAME_PATTERN.test(repo.name) ||
    AWESOME_DESCRIPTION_PATTERN.test(repo.description ?? "")
  );
}

function contributionSignals(repo: RepoRecord): number {
  return (
    repo.goodFirstIssues +
    repo.helpWantedIssues +
    repo.firstTimersIssues +
    repo.upForGrabsIssues
  );
}

export interface FilterOptions {
  /**
   * Pre-enrichment filtering only has REST search metadata. Contribution
   * signals and license details are often incomplete until GraphQL enrichment,
   * so the strictest checks are applied afterwards.
   */
  preEnrich?: boolean;
}

export function filterRepo(
  repo: RepoRecord,
  config: StaryuConfig,
  options: FilterOptions = {},
): FilterResult {
  if (repo.archived) {
    return { ok: false, reason: "archived" };
  }
  if (repo.fork) {
    return { ok: false, reason: "fork" };
  }
  if (repo.disabled) {
    return { ok: false, reason: "disabled" };
  }
  if (repo.stars < config.preferences.stars.min || repo.stars > config.preferences.stars.max) {
    return { ok: false, reason: "outside star range" };
  }

  const pushedDays = daysSince(repo.pushedAt);
  if (pushedDays === null || pushedDays > config.preferences.activity.pushedWithinDays) {
    return { ok: false, reason: "inactive" };
  }

  const excluded = new Set(config.preferences.topics.exclude.map((topic) => topic.toLowerCase()));
  if (repo.topics.some((topic) => excluded.has(topic.toLowerCase()))) {
    return { ok: false, reason: "excluded topic" };
  }

  if (hasAwesomeMarker(repo)) {
    return { ok: false, reason: "awesome list" };
  }

  if (!options.preEnrich && config.preferences.license.required) {
    const allow = new Set(config.preferences.license.allow.map((value) => value.toLowerCase()));
    if (!repo.license || !allow.has(repo.license.toLowerCase())) {
      return { ok: false, reason: "license not allowed" };
    }
  }

  if (!options.preEnrich && config.preferences.contribution.requireAnySignal) {
    if (contributionSignals(repo) === 0 && !repo.contributingGuide) {
      return { ok: false, reason: "no contribution signal" };
    }
  }

  return { ok: true, reason: null };
}

function addReason(reasons: RepoReason[], code: string, label: string, points: number): number {
  if (points <= 0) {
    return 0;
  }
  reasons.push({ code, label, points: Math.round(points * 10) / 10 });
  return points;
}

export function classifyIntent(repo: RepoRecord, sourceIntent: Intent): Intent {
  const hasSignal =
    contributionSignals(repo) > 0 ||
    repo.contributingGuide ||
    repo.recentOutsiderMergedPrs > 0;

  if (sourceIntent === "use") {
    return hasSignal ? "both" : "use";
  }
  return hasSignal ? "contribute" : "use";
}

/**
 * Deterministic 0-100 score. Every component contributes a named reason so the
 * user can see why a repository was recommended. No randomness, no LLM.
 */
export function scoreRepo(repo: RepoRecord, config: StaryuConfig, sourceIntent: Intent): Candidate {
  const reasons: RepoReason[] = [];
  let score = 0;

  if (config.preferences.languages.length === 0) {
    score += addReason(reasons, "language", repo.language ?? "any language", 8);
  } else if (repo.language && config.preferences.languages.includes(repo.language)) {
    score += addReason(reasons, "language", repo.language, 25);
  }

  const includedTopics = new Set(
    config.preferences.topics.include.map((topic) => topic.toLowerCase()),
  );
  const matchedTopics = repo.topics.filter((topic) => includedTopics.has(topic.toLowerCase()));
  if (matchedTopics.length > 0) {
    const points = Math.min(18, matchedTopics.length * 6);
    score += addReason(reasons, "topic", `topics: ${matchedTopics.slice(0, 3).join(", ")}`, points);
  }

  const popularity = Math.min(15, Math.log10(Math.max(repo.stars, 1)) * 3);
  score += addReason(reasons, "stars", `${repo.stars.toLocaleString("en-US")} stars`, popularity);

  const pushedDays = daysSince(repo.pushedAt);
  if (pushedDays !== null) {
    if (pushedDays <= 30) {
      score += addReason(reasons, "active", "pushed this month", 12);
    } else if (pushedDays <= 90) {
      score += addReason(reasons, "active", "pushed this quarter", 8);
    } else if (pushedDays <= config.preferences.activity.pushedWithinDays) {
      score += addReason(reasons, "active", `pushed ${pushedDays} days ago`, 4);
    }
  }

  if (repo.goodFirstIssues > 0) {
    score += addReason(
      reasons,
      "good-first",
      `${repo.goodFirstIssues} good first issue${repo.goodFirstIssues === 1 ? "" : "s"}`,
      Math.min(8, 4 + Math.log2(repo.goodFirstIssues + 1) * 1.5),
    );
  }
  if (repo.helpWantedIssues > 0) {
    score += addReason(
      reasons,
      "help-wanted",
      `${repo.helpWantedIssues} help wanted`,
      Math.min(5, 3 + Math.log2(repo.helpWantedIssues + 1)),
    );
  }
  if (repo.firstTimersIssues > 0) {
    score += addReason(reasons, "first-timers", "first-timers-only issues", 4);
  }
  if (repo.upForGrabsIssues > 0) {
    score += addReason(reasons, "up-for-grabs", "up-for-grabs issues", 3);
  }
  if (repo.contributingGuide) {
    score += addReason(reasons, "contributing", "contributing guide", 4);
  }
  if (repo.recentOutsiderMergedPrs > 0) {
    score += addReason(
      reasons,
      "merged-prs",
      "recent outside contributions merged",
      Math.min(6, repo.recentOutsiderMergedPrs * 2),
    );
  }
  if (sourceIntent !== "use") {
    score += addReason(reasons, "intent", "beginner-friendly project", 5);
  }

  reasons.sort((a, b) => b.points - a.points);

  return {
    repo,
    score: Math.round(Math.min(100, Math.max(0, score)) * 10) / 10,
    reasons,
    intent: classifyIntent(repo, sourceIntent),
    sourceIntent,
  };
}
