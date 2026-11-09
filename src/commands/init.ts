import { getAppPaths, ensureAppDirs } from "../core/paths.ts";
import { loadConfigIfExists, defaultConfig, saveConfig, type StaryuConfig } from "../core/config.ts";
import { getToken, saveToken } from "../core/credentials.ts";
import { openDatabase, createRun, finishRun, upsertRepo, listStarredRepos, markRepoUnstarred } from "../core/db.ts";
import { GitHubClient } from "../github/client.ts";
import { RestApi } from "../github/rest.ts";
import { GraphQLApi } from "../github/graphql.ts";
import { inferProfile } from "../core/profile.ts";
import { repoFromSearch } from "../core/mapper.ts";
import { syncStars } from "../core/sync.ts";
import { UserError, messageOf } from "../core/errors.ts";
import { ensure, createProgress, p } from "../ui/prompts.ts";

const COMMON_LANGUAGES = [
  "TypeScript",
  "JavaScript",
  "Python",
  "Go",
  "Rust",
  "Java",
  "C++",
  "C#",
  "Ruby",
  "PHP",
  "Swift",
  "Kotlin",
  "Elixir",
  "Zig",
  "Lua",
  "Shell",
];

function nearestActivity(value: number): number {
  const options = [90, 180, 365];
  return options.reduce((best, option) =>
    Math.abs(option - value) < Math.abs(best - value) ? option : best,
  );
}

export interface InitOptions {
  force?: boolean;
  debug?: boolean;
}

export async function initCommand(options: InitOptions = {}): Promise<void> {
  p.intro("staryu init");

  const paths = getAppPaths();
  ensureAppDirs(paths);

  const existingConfig = loadConfigIfExists();
  if (existingConfig && !options.force) {
    const reconfigure = ensure(
      await p.confirm({
        message: `Config already exists at ${paths.configFile}. Reconfigure?`,
        initialValue: false,
      }),
    );
    if (!reconfigure) {
      p.outro("Keeping existing configuration.");
      return;
    }
  }

  let token = getToken();
  if (!token.token) {
    const input = ensure(
      await p.password({
        message: "GitHub personal access token (needs repo/public_repo to star and list access)",
        validate: (value) => ((value ?? "").trim().length === 0 ? "A token is required." : undefined),
      }),
    );
    token = { token: input.trim(), source: "file" };
  }
  if (!token.token) {
    throw new UserError("No token provided.");
  }

  const client = new GitHubClient(token.token, {
    debug: options.debug ?? process.env.STARYU_DEBUG === "1",
  });
  const rest = new RestApi(client);
  const graphql = new GraphQLApi(client);

  const authProgress = createProgress("Validating token");
  let user;
  try {
    user = await rest.getUser();
    authProgress.stop(`Authenticated as ${user.login}`);
  } catch (error) {
    authProgress.fail("Token validation failed");
    throw new UserError(
      `GitHub rejected the token: ${messageOf(error)}. Create a new token and try again.`,
    );
  }

  if (token.source !== "env") {
    saveToken(token.token);
  }

  if (token.token.startsWith("github_pat_")) {
    p.log.warn(
      "This is a fine-grained token. GitHub may reject starring and list writes from it. " +
        "Use a classic token with `repo`/`public_repo` and `user` scopes for the full star + list flow.",
    );
  }

  try {
    const scopes = await client.getScopes();
    if (scopes && scopes.length > 0) {
      if (!scopes.some((scope) => scope === "repo" || scope === "public_repo")) {
        p.log.warn(
          `Token scopes (${scopes.join(", ")}) may not allow starring. Add repo or public_repo.`,
        );
      }
      if (!scopes.includes("user")) {
        p.log.warn(
          `Token scopes (${scopes.join(", ")}) may not allow list writes. Add the user scope.`,
        );
      }
    }
  } catch {
    // Scope headers are informational only.
  }

  const starsProgress = createProgress("Fetching your existing stars");
  const starred = await rest.listStarredAll({
    onPage: (page, repos) => starsProgress.update(`Fetching stars: page ${page} (${repos.length})`),
  });
  starsProgress.stop(`Found ${starred.length} starred repositories`);

  const profile = inferProfile(starred);

  const languageChoices = profile.languages.length > 0
    ? profile.languages.slice(0, 12)
    : [];
  const languageOptions = [
    ...languageChoices.map((language) => ({
      value: language.name,
      label: `${language.name} (${language.count})`,
    })),
    ...COMMON_LANGUAGES
      .filter((language) => !languageChoices.some((choice) => choice.name === language))
      .map((language) => ({ value: language, label: language })),
  ];

  const languages = ensure(
    await p.multiselect({
      message: "Which languages should staryu focus on? (space to select)",
      options: languageOptions,
      initialValues: profile.suggested.languages,
      required: false,
    }),
  );

  const starMin = ensure(
    await p.text({
      message: "Minimum stars",
      initialValue: String(profile.suggested.starMin),
      validate: (value) => (Number.isFinite(Number(value ?? "")) ? undefined : "Enter a number"),
    }),
  );
  const starMax = ensure(
    await p.text({
      message: "Maximum stars",
      initialValue: String(profile.suggested.starMax),
      validate: (value) => (Number.isFinite(Number(value ?? "")) ? undefined : "Enter a number"),
    }),
  );

  const activity = ensure(
    await p.select<number>({
      message: "How recently must a repository have been pushed to?",
      options: [
        { value: 90, label: "Last 90 days" },
        { value: 180, label: "Last 180 days" },
        { value: 365, label: "Last year" },
      ],
      initialValue: nearestActivity(profile.suggested.activeDays),
    }),
  );

  const contribution = ensure(
    await p.confirm({
      message: "Include beginner-friendly contribution signals (good first issue, help wanted)?",
      initialValue: true,
    }),
  );

  const licenseRequired = ensure(
    await p.confirm({
      message: "Require a permissive license (MIT, Apache-2.0, BSD, ISC, MPL-2.0)?",
      initialValue: false,
    }),
  );

  const listName = ensure(
    await p.text({
      message: "Name of the public GitHub list",
      initialValue: existingConfig?.github.list.name ?? "staryu",
      validate: (value) => ((value ?? "").trim().length === 0 ? "A list name is required." : undefined),
    }),
  );

  const listPrivate = ensure(
    await p.confirm({
      message: "Make the list private?",
      initialValue: false,
    }),
  );

  const min = Number(starMin);
  const max = Number(starMax);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
    throw new UserError("Maximum stars must be greater than or equal to minimum stars.");
  }

  const config: StaryuConfig = defaultConfig();
  config.github.login = user.login;
  config.github.list.name = listName;
  config.github.list.private = listPrivate;
  config.preferences.languages = (languages as string[]).filter(Boolean);
  config.preferences.stars = { min: Math.round(min), max: Math.round(max) };
  config.preferences.topics.include = profile.suggested.topics.slice(0, 10);
  config.preferences.activity.pushedWithinDays = activity;
  config.preferences.contribution.enabled = contribution;
  config.preferences.license.required = licenseRequired;

  saveConfig(config);

  const db = openDatabase(paths.dbFile);
  const currentStarIds = new Set(starred.map((repo) => repo.id));
  for (const known of listStarredRepos(db)) {
    if (!currentStarIds.has(known.id)) {
      markRepoUnstarred(db, known.nodeId);
    }
  }
  for (const repo of starred) {
    upsertRepo(db, repoFromSearch(repo, { starredVia: "user" }));
  }

  p.log.success(`Saved config to ${paths.configFile}`);
  p.log.info(`Database: ${paths.dbFile}`);

  if (starred.length > 0) {
    const shouldSync = ensure(
      await p.confirm({
        message: `Add all ${starred.length} existing stars to the "${listName}" list now?`,
        initialValue: true,
      }),
    );
    if (shouldSync) {
      const runId = createRun(db, "sync", config);
      const progress = createProgress(`Syncing ${starred.length} stars into "${listName}"`);
      try {
        const result = await syncStars({
          rest,
          graphql,
          db,
          config,
          runId,
          onProgress: progress.update,
        });
        finishRun(db, runId, result.failures.length > 0 ? "partial" : "completed", result);
        progress.stop(
          result.failures.length > 0
            ? `Added ${result.added}, ${result.failures.length} failed`
            : `List is up to date (${result.totalStars} stars)`,
        );
        if (result.list.isPrivate !== config.github.list.private) {
          p.log.warn(
            `List "${result.list.name}" is ${result.list.isPrivate ? "private" : "public"}, but the config expects ${config.github.list.private ? "private" : "public"}.`,
          );
        }
        for (const failure of result.failures.slice(0, 5)) {
          p.log.warn(`${failure.repo}: ${failure.error}`);
        }
      } catch (error) {
        finishRun(db, runId, "failed", { error: messageOf(error) });
        progress.fail(`Sync failed: ${messageOf(error)}`);
      }
    }
  }

  if (existingConfig && existingConfig.github.login && existingConfig.github.login !== user.login) {
    p.log.info(`Account changed from ${existingConfig.github.login} to ${user.login}.`);
  }

  p.outro("Setup complete. Run `staryu discover` to find repositories.");
}
