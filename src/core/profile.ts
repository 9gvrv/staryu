import type { GitHubSearchRepo } from "../types.ts";

export interface CountedValue {
  name: string;
  count: number;
  percent: number;
}

export interface InferredProfile {
  totalStars: number;
  languages: CountedValue[];
  topics: CountedValue[];
  licenses: CountedValue[];
  stars: {
    min: number;
    p10: number;
    p25: number;
    median: number;
    p75: number;
    p90: number;
    max: number;
  };
  pushedWithinDays: {
    median: number;
    p75: number;
  };
  suggested: {
    languages: string[];
    topics: string[];
    starMin: number;
    starMax: number;
    activeDays: number;
    licenses: string[];
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  if (sorted.length === 1) {
    return sorted[0] ?? 0;
  }
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * weight;
}

function countValues(values: string[]): CountedValue[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
    }
  }
  const total = values.filter((value) => value.trim().length > 0).length;
  return [...counts.entries()]
    .map(([name, count]) => ({
      name,
      count,
      percent: total === 0 ? 0 : Math.round((count / total) * 100),
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
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

function niceFloor(value: number): number {
  if (value <= 0) {
    return 0;
  }
  const power = 10 ** Math.floor(Math.log10(value));
  return Math.floor(value / power) * power;
}

function niceCeil(value: number): number {
  if (value <= 0) {
    return 1;
  }
  const power = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / power) * power;
}

function suggestStarRange(stars: number[]): { min: number; max: number } {
  if (stars.length === 0) {
    return { min: 100, max: 50_000 };
  }
  const sorted = [...stars].sort((a, b) => a - b);
  const p25 = percentile(sorted, 0.25);
  const p75 = percentile(sorted, 0.75);
  let min = Math.max(0, niceFloor(p25));
  let max = Math.max(min + 1, niceCeil(p75));
  if (max <= min) {
    min = Math.max(0, Math.floor(max / 2));
  }
  if (max > 100_000_000) {
    max = 100_000_000;
  }
  return { min, max };
}

function suggestActivityDays(days: number[]): number {
  if (days.length === 0) {
    return 180;
  }
  const sorted = [...days].sort((a, b) => a - b);
  const p75 = percentile(sorted, 0.75);
  const rounded = Math.ceil(p75 / 30) * 30;
  return Math.max(90, Math.min(365, rounded || 180));
}

export function inferProfile(repos: GitHubSearchRepo[]): InferredProfile {
  const languages = countValues(
    repos
      .map((repo) => repo.language)
      .filter((language): language is string => Boolean(language)),
  );
  const topics = countValues(repos.flatMap((repo) => repo.topics ?? []));
  const licenses = countValues(
    repos
      .map((repo) => repo.license?.spdx_id ?? repo.license?.name ?? null)
      .filter((license): license is string => Boolean(license)),
  );
  const stars = repos.map((repo) => repo.stargazers_count).sort((a, b) => a - b);
  const days = repos
    .map((repo) => daysSince(repo.pushed_at))
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);

  const starRange = suggestStarRange(stars);
  const activityDays = suggestActivityDays(days);

  return {
    totalStars: repos.length,
    languages,
    topics,
    licenses,
    stars: {
      min: stars[0] ?? 0,
      p10: percentile(stars, 0.1),
      p25: percentile(stars, 0.25),
      median: percentile(stars, 0.5),
      p75: percentile(stars, 0.75),
      p90: percentile(stars, 0.9),
      max: stars[stars.length - 1] ?? 0,
    },
    pushedWithinDays: {
      median: percentile(days, 0.5),
      p75: percentile(days, 0.75),
    },
    suggested: {
      languages: languages.slice(0, 5).map((language) => language.name),
      topics: topics.slice(0, 10).map((topic) => topic.name),
      starMin: starRange.min,
      starMax: starRange.max,
      activeDays: activityDays,
      licenses: licenses.slice(0, 5).map((license) => license.name),
    },
  };
}
