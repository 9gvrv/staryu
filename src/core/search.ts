import type { Intent, SearchQuery } from "../types.ts";
import type { StaryuConfig } from "./config.ts";
import type { RestApi } from "../github/rest.ts";
import type { GitHubSearchRepo } from "../types.ts";

function formatDate(daysAgo: number): string {
  const date = new Date(Date.now() - daysAgo * 86_400_000);
  return date.toISOString().slice(0, 10);
}

function starRange(config: StaryuConfig): string {
  const { min, max } = config.preferences.stars;
  return `stars:${Math.max(0, Math.round(min))}..${Math.round(max)}`;
}

function licenseQualifier(config: StaryuConfig): string | null {
  if (!config.preferences.license.required) {
    return null;
  }
  const license = config.preferences.license.allow[0];
  if (!license) {
    return null;
  }
  return `license:${license.toLowerCase().replace(/[^a-z0-9.+-]/g, "")}`;
}

function baseQualifiers(config: StaryuConfig): string[] {
  const parts = [
    "is:public",
    "archived:false",
    "fork:false",
    starRange(config),
  ];
  const pushed = formatDate(config.preferences.activity.pushedWithinDays);
  parts.push(`pushed:>=${pushed}`);
  const license = licenseQualifier(config);
  if (license) {
    parts.push(license);
  }
  return parts;
}

function languageQualifier(language: string): string {
  return /^[a-zA-Z0-9_+#.-]+$/.test(language) ? `language:${language}` : `language:"${language}"`;
}

function topicQualifier(topic: string): string {
  return `topic:${topic.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/**
 * Build deterministic search queries from the user's preferences.
 *
 * GitHub search ANDs every qualifier, so we cannot express "any of these
 * languages" in one query. Instead we emit one query per top language and
 * rely on de-duplication afterwards. Contribution queries add a signal
 * qualifier so beginner-friendly projects get a fair chance in the pool.
 */
export function buildSearchQueries(config: StaryuConfig): SearchQuery[] {
  const queries: SearchQuery[] = [];
  const base = baseQualifiers(config).join(" ");
  const languages = config.preferences.languages.slice(0, 3);
  const topics = config.preferences.topics.include.slice(0, 2);
  const contribution = config.preferences.contribution.enabled;

  const add = (id: string, q: string, intent: Intent, sort: SearchQuery["sort"]) => {
    if (queries.length >= config.run.search.maxQueries) {
      return;
    }
    queries.push({ id, q, intent, sort });
  };

  if (languages.length === 0) {
    add("general", base, "use", "stars");
    if (contribution) {
      add("general-contribute", `${base} good-first-issues:>=1`, "contribute", "updated");
    }
  }

  for (const language of languages) {
    add(`lang:${language}`, `${base} ${languageQualifier(language)}`, "use", "stars");
  }

  if (contribution) {
    for (const language of languages) {
      add(
        `contribute:${language}`,
        `${base} ${languageQualifier(language)} good-first-issues:>=1`,
        "contribute",
        "updated",
      );
    }
  }

  for (const topic of topics) {
    add(`topic:${topic}`, `${base} ${topicQualifier(topic)}`, "use", "stars");
  }

  if (queries.length === 0) {
    add("fallback", base, "use", "stars");
  }

  return queries;
}

export interface SearchOutcome {
  repos: Map<number, { repo: GitHubSearchRepo; sourceIntent: Intent }>;
  queries: SearchQuery[];
  errors: string[];
  totalFetched: number;
}

function combineIntent(current: Intent, next: Intent): Intent {
  if (current === next) {
    return current;
  }
  return "both";
}

export interface SearchDeps {
  rest: RestApi;
  config: StaryuConfig;
  onProgress?: (message: string) => void;
}

export async function runSearch(deps: SearchDeps): Promise<SearchOutcome> {
  const queries = buildSearchQueries(deps.config);
  const repos = new Map<number, { repo: GitHubSearchRepo; sourceIntent: Intent }>();
  const errors: string[] = [];
  let totalFetched = 0;

  for (const query of queries) {
    deps.onProgress?.(`Searching GitHub: ${query.id}`);
    try {
      for (let page = 1; page <= deps.config.run.search.pagesPerQuery; page += 1) {
        const response = await deps.rest.searchRepositories(query.q, {
          sort: query.sort,
          perPage: deps.config.run.search.perPage,
          page,
        });
        totalFetched += response.items.length;
        for (const repo of response.items) {
          const existing = repos.get(repo.id);
          if (existing) {
            existing.sourceIntent = combineIntent(existing.sourceIntent, query.intent);
          } else {
            repos.set(repo.id, { repo, sourceIntent: query.intent });
          }
        }
        if (response.items.length < deps.config.run.search.perPage) {
          break;
        }
      }
    } catch (error) {
      errors.push(
        `Search "${query.id}" failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { repos, queries, errors, totalFetched };
}
