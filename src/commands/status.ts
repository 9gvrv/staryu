import { loadConfigIfExists } from "../core/config.ts";
import { getToken, redactToken, credentialPermissionWarning } from "../core/credentials.ts";
import { ensureAppDirs, getAppPaths } from "../core/paths.ts";
import { openDatabase, getStats } from "../core/db.ts";
import { GitHubClient } from "../github/client.ts";
import { RestApi } from "../github/rest.ts";
import { GraphQLApi } from "../github/graphql.ts";
import { messageOf } from "../core/errors.ts";
import { cliCommand } from "../core/invocation.ts";
import { p } from "../ui/prompts.ts";

export interface StatusOptions {
  debug?: boolean;
}

export async function statusCommand(options: StatusOptions = {}): Promise<void> {
  const paths = getAppPaths();
  ensureAppDirs(paths);
  const config = loadConfigIfExists();
  const db = openDatabase(paths.dbFile);
  const stats = getStats(db);
  const token = getToken();

  const lines: string[] = [
    `config     ${paths.configFile}${config ? "" : ` (missing; run \`${cliCommand("init")}\`)`}`,
    `database   ${paths.dbFile}`,
    `token      ${token.source === "env" ? `environment (${redactToken(token.token)})` : token.token ? `file (${redactToken(token.token)})` : "(not set)"}`,
    `repos      ${stats.repos} tracked, ${stats.starred} starred, ${stats.listed} in a list`,
    `runs       ${stats.runs}${stats.lastRun ? ` (latest #${stats.lastRun.id} ${stats.lastRun.command} ${stats.lastRun.status})` : ""}`,
  ];

  const permissionWarning = credentialPermissionWarning();
  if (permissionWarning) {
    lines.push(`warning    ${permissionWarning}`);
  }

  if (config) {
    lines.push(
      `account    ${config.github.login ?? "(not signed in)"}`,
      `list       ${config.github.list.name} (${config.github.list.private ? "private" : "public"})`,
      `languages  ${config.preferences.languages.length > 0 ? config.preferences.languages.join(", ") : "any"}`,
      `stars      ${config.preferences.stars.min.toLocaleString("en-US")} - ${config.preferences.stars.max.toLocaleString("en-US")}`,
      `activity   pushed within ${config.preferences.activity.pushedWithinDays} days`,
    );
  }

  if (token.token) {
    const client = new GitHubClient(token.token, {
      debug: options.debug ?? process.env.STARYU_DEBUG === "1",
    });
    const rest = new RestApi(client);
    const graphql = new GraphQLApi(client);
    try {
      const user = await rest.getUser();
      const starred = await graphql.getStarredCount();
      const lists = await graphql.getLists();
      const listName = config?.github.list.name ?? "staryu";
      const list = lists.find((entry) => entry.name.toLowerCase() === listName.toLowerCase());
      lines.push(
        `github     ${user.login} · ${starred} stars`,
        `list state ${list ? `"${list.name}" has ${list.itemCount} items` : `"${listName}" does not exist yet`}`,
        `rate limit ${client.lastRateLimit.remaining ?? "?"}/${client.lastRateLimit.limit ?? "?"}`,
      );
    } catch (error) {
      lines.push(`github     unavailable (${messageOf(error)})`);
    }
  }

  p.note(lines.join("\n"), "staryu status");
}
