import type { GitHubList } from "../types.ts";
import type { GraphQLApi } from "../github/graphql.ts";
import type { StaryuConfig } from "./config.ts";
import { messageOf, UserError } from "./errors.ts";

function explainListError(error: unknown): Error {
  const message = messageOf(error);
  if (/resource not accessible|not accessible by personal access token|forbidden/i.test(message)) {
    return new UserError(
      "GitHub denied access to your lists. GitHub Lists writes currently require a classic " +
        "personal access token with the `repo` (or `public_repo`) and `user` scopes. " +
        "Fine-grained tokens can read lists but are rejected when creating or modifying them. " +
        "Create a classic token and run `staryu init` again.",
    );
  }
  return error instanceof Error ? error : new Error(message);
}

export async function findStaryuList(
  graphql: GraphQLApi,
  config: StaryuConfig,
): Promise<GitHubList | null> {
  const lists = await graphql.getLists();
  const name = config.github.list.name.toLowerCase();
  return lists.find((list) => list.name.toLowerCase() === name) ?? null;
}

export async function ensureStaryuList(
  graphql: GraphQLApi,
  config: StaryuConfig,
): Promise<GitHubList> {
  try {
    const existing = await findStaryuList(graphql, config);
    if (existing) {
      return existing;
    }
    return await graphql.createList(
      config.github.list.name,
      config.github.list.description,
      config.github.list.private,
    );
  } catch (error) {
    throw explainListError(error);
  }
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

export function unionListIds(existing: string[] | undefined, listId: string): string[] {
  const ids = new Set(existing ?? []);
  ids.add(listId);
  return [...ids];
}
