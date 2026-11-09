import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, getAppPaths } from "./paths.ts";

export interface StaryuConfig {
  version: 1;
  github: {
    login: string | null;
    list: {
      name: string;
      description: string;
      private: boolean;
    };
  };
  preferences: {
    languages: string[];
    stars: {
      min: number;
      max: number;
    };
    topics: {
      include: string[];
      exclude: string[];
    };
    activity: {
      pushedWithinDays: number;
    };
    license: {
      required: boolean;
      allow: string[];
    };
    contribution: {
      enabled: boolean;
      labels: string[];
      minGoodFirstIssues: number;
      requireAnySignal: boolean;
    };
  };
  run: {
    maxNewStars: number;
    candidatePool: number;
    search: {
      perPage: number;
      pagesPerQuery: number;
      maxQueries: number;
    };
    enrich: {
      enabled: boolean;
      batchSize: number;
      deep: boolean;
    };
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const DEFAULT_LABELS = [
  "good first issue",
  "help wanted",
  "first-timers-only",
  "up-for-grabs",
];

export const DEFAULT_LICENSES = [
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MPL-2.0",
];

export function defaultConfig(): StaryuConfig {
  return {
    version: 1,
    github: {
      login: null,
      list: {
        name: "staryu",
        description: "Repositories I use and want to contribute to. Curated by staryu.",
        private: false,
      },
    },
    preferences: {
      languages: [],
      stars: { min: 100, max: 50_000 },
      topics: { include: [], exclude: ["awesome", "awesome-list"] },
      activity: { pushedWithinDays: 180 },
      license: { required: false, allow: [...DEFAULT_LICENSES] },
      contribution: {
        enabled: true,
        labels: [...DEFAULT_LABELS],
        minGoodFirstIssues: 0,
        requireAnySignal: false,
      },
    },
    run: {
      maxNewStars: 20,
      candidatePool: 60,
      search: { perPage: 50, pagesPerQuery: 1, maxQueries: 8 },
      enrich: { enabled: true, batchSize: 20, deep: true },
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeDeep<T>(defaults: T, value: unknown): T {
  if (!isPlainObject(defaults) || !isPlainObject(value)) {
    return (value === undefined ? defaults : value) as T;
  }

  const result: Record<string, unknown> = { ...defaults };
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) {
      continue;
    }
    const existing = (defaults as Record<string, unknown>)[key];
    result[key] = isPlainObject(existing) && isPlainObject(child)
      ? mergeDeep(existing, child)
      : child;
  }
  return result as T;
}

function asStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(`${path} must be an array of strings`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new ConfigError(`${path}[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function asNumber(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigError(`${path} must be a number`);
  }
  const rounded = Math.round(value);
  if (rounded < min || rounded > max) {
    throw new ConfigError(`${path} must be between ${min} and ${max}`);
  }
  return rounded;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new ConfigError(`${path} must be a boolean`);
  }
  return value;
}

function normalizeTopics(topics: string[]): string[] {
  return [...new Set(
    topics
      .map((topic) => topic.trim().toLowerCase().replace(/^#/, ""))
      .filter((topic) => topic.length > 0),
  )];
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

export function validateConfig(value: unknown): StaryuConfig {
  const merged = mergeDeep(defaultConfig(), value) as StaryuConfig;

  if (merged.version !== 1) {
    throw new ConfigError("Unsupported config version. Expected version: 1");
  }

  merged.github.login = typeof merged.github.login === "string" && merged.github.login.trim().length > 0
    ? merged.github.login.trim()
    : null;
  merged.github.list.name = asString(merged.github.list.name, "github.list.name");
  merged.github.list.description = asString(
    merged.github.list.description,
    "github.list.description",
  );
  merged.github.list.private = asBoolean(merged.github.list.private, "github.list.private");

  merged.preferences.languages = uniqueStrings(
    asStringArray(merged.preferences.languages, "preferences.languages"),
  );
  merged.preferences.stars.min = asNumber(
    merged.preferences.stars.min,
    "preferences.stars.min",
    0,
    100_000_000,
  );
  merged.preferences.stars.max = asNumber(
    merged.preferences.stars.max,
    "preferences.stars.max",
    1,
    100_000_000,
  );
  if (merged.preferences.stars.max < merged.preferences.stars.min) {
    throw new ConfigError("preferences.stars.max must be greater than or equal to preferences.stars.min");
  }

  merged.preferences.topics.include = normalizeTopics(
    asStringArray(merged.preferences.topics.include, "preferences.topics.include"),
  );
  merged.preferences.topics.exclude = normalizeTopics(
    asStringArray(merged.preferences.topics.exclude, "preferences.topics.exclude"),
  );
  merged.preferences.activity.pushedWithinDays = asNumber(
    merged.preferences.activity.pushedWithinDays,
    "preferences.activity.pushedWithinDays",
    1,
    3650,
  );
  merged.preferences.license.required = asBoolean(
    merged.preferences.license.required,
    "preferences.license.required",
  );
  merged.preferences.license.allow = uniqueStrings(
    asStringArray(merged.preferences.license.allow, "preferences.license.allow"),
  );

  merged.preferences.contribution.enabled = asBoolean(
    merged.preferences.contribution.enabled,
    "preferences.contribution.enabled",
  );
  merged.preferences.contribution.labels = uniqueStrings(
    asStringArray(merged.preferences.contribution.labels, "preferences.contribution.labels"),
  );
  merged.preferences.contribution.minGoodFirstIssues = asNumber(
    merged.preferences.contribution.minGoodFirstIssues,
    "preferences.contribution.minGoodFirstIssues",
    0,
    10_000,
  );
  merged.preferences.contribution.requireAnySignal = asBoolean(
    merged.preferences.contribution.requireAnySignal,
    "preferences.contribution.requireAnySignal",
  );

  merged.run.maxNewStars = asNumber(merged.run.maxNewStars, "run.maxNewStars", 1, 100);
  merged.run.candidatePool = asNumber(merged.run.candidatePool, "run.candidatePool", 1, 500);
  merged.run.search.perPage = asNumber(merged.run.search.perPage, "run.search.perPage", 1, 100);
  merged.run.search.pagesPerQuery = asNumber(
    merged.run.search.pagesPerQuery,
    "run.search.pagesPerQuery",
    1,
    10,
  );
  merged.run.search.maxQueries = asNumber(merged.run.search.maxQueries, "run.search.maxQueries", 1, 30);
  merged.run.enrich.enabled = asBoolean(merged.run.enrich.enabled, "run.enrich.enabled");
  merged.run.enrich.batchSize = asNumber(merged.run.enrich.batchSize, "run.enrich.batchSize", 1, 50);
  merged.run.enrich.deep = asBoolean(merged.run.enrich.deep, "run.enrich.deep");

  return merged;
}

export function loadConfig(): StaryuConfig {
  const paths = getAppPaths();
  if (!existsSync(paths.configFile)) {
    throw new ConfigError(`No config found at ${paths.configFile}. Run \`staryu init\` first.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths.configFile, "utf8"));
  } catch (error) {
    throw new ConfigError(
      `Could not parse ${paths.configFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return validateConfig(parsed);
}

export function loadConfigIfExists(): StaryuConfig | null {
  const paths = getAppPaths();
  if (!existsSync(paths.configFile)) {
    return null;
  }
  return loadConfig();
}

export function saveConfig(config: StaryuConfig): void {
  const paths = getAppPaths();
  ensureDir(paths.configDir);
  const validated = validateConfig(config);
  const payload = `${JSON.stringify(validated, null, 2)}\n`;
  if (process.platform === "win32") {
    writeFileSync(paths.configFile, payload, { mode: 0o644 });
    return;
  }
  const tempFile = join(paths.configDir, `.config-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tempFile, payload, { mode: 0o644 });
  renameSync(tempFile, paths.configFile);
}
