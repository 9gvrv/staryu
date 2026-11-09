import type { GitHubClient } from "./client.ts";
import type { EnrichedRepo, GitHubList } from "../types.ts";

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface ViewerResponse {
  viewer: {
    login: string;
  };
}

interface ListNode {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isPrivate: boolean;
  items: {
    totalCount: number;
  };
}

interface ListsResponse {
  viewer: {
    lists: {
      pageInfo: PageInfo;
      nodes: ListNode[];
    };
  };
}

interface ListItemsResponse {
  node: {
    __typename: string;
    items?: {
      pageInfo: PageInfo;
      nodes: Array<{
        __typename: string;
        id?: string;
        nameWithOwner?: string;
      }>;
    };
  } | null;
}

interface CreateListResponse {
  createUserList: {
    list: ListNode;
  };
}

interface UpdateListResponse {
  updateUserList: {
    list: ListNode;
  };
}

interface UpdateListsItemResponse {
  item: {
    __typename: string;
    id?: string;
    nameWithOwner?: string;
  } | null;
  lists: Array<{
    id: string;
    name: string;
  }>;
}

interface RepositoryNode {
  id: string;
  nameWithOwner: string;
  url: string;
  description: string | null;
  stargazerCount: number;
  forkCount: number;
  isArchived: boolean;
  isFork: boolean;
  isDisabled: boolean;
  hasIssuesEnabled: boolean;
  pushedAt: string | null;
  createdAt: string;
  updatedAt: string;
  primaryLanguage: { name: string } | null;
  licenseInfo: { spdxId: string | null; name: string } | null;
  repositoryTopics: {
    nodes: Array<{
      topic: { name: string };
    }>;
  };
  openIssues: { totalCount: number };
  viewerHasStarred: boolean;
  [labelAlias: string]: unknown;
  contributingRoot: { __typename: string; byteSize?: number } | null;
  contributingGithub: { __typename: string; byteSize?: number } | null;
  contributingDocs: { __typename: string; byteSize?: number } | null;
  recentMergedPRs?: {
    nodes: Array<{
      mergedAt: string | null;
      authorAssociation: string;
    }>;
  };
}

function mapList(node: ListNode): GitHubList {
  return {
    id: node.id,
    name: node.name,
    slug: node.slug,
    description: node.description,
    isPrivate: node.isPrivate,
    itemCount: node.items.totalCount,
  };
}

function isBlob(value: { __typename: string } | null): boolean {
  return value?.__typename === "Blob";
}

function countLabel(node: RepositoryNode, index: number): number {
  const value = node[`label${index}`];
  if (value && typeof value === "object" && "totalCount" in value) {
    const total = (value as { totalCount?: unknown }).totalCount;
    return typeof total === "number" ? total : 0;
  }
  return 0;
}

function countOutsiderMergedPrs(node: RepositoryNode): number {
  const nodes = node.recentMergedPRs?.nodes ?? [];
  const outsider = new Set([
    "FIRST_TIME_CONTRIBUTOR",
    "FIRST_TIMER",
    "CONTRIBUTOR",
    "NONE",
  ]);
  return nodes.filter((pr) => outsider.has(pr.authorAssociation)).length;
}

function buildEnrichmentQuery(
  repos: Array<{ owner: string; name: string }>,
  labels: string[],
  deep: boolean,
): { query: string; variables: Record<string, unknown> } {
  const variables: Record<string, unknown> = {};
  const variableDeclarations: string[] = [];
  const labelDeclarations: string[] = [];
  const labelFields: string[] = [];

  labels.forEach((label, index) => {
    variableDeclarations.push(`$label${index}: [String!]!`);
    variables[`label${index}`] = [label];
    labelFields.push(`label${index}: issues(states: OPEN, labels: $label${index}) { totalCount }`);
  });

  const repoFields = repos.map((repo, index) => {
    variableDeclarations.push(`$owner${index}: String!`);
    variableDeclarations.push(`$name${index}: String!`);
    variables[`owner${index}`] = repo.owner;
    variables[`name${index}`] = repo.name;

    return `
      r${index}: repository(owner: $owner${index}, name: $name${index}) {
        id
        nameWithOwner
        url
        description
        stargazerCount
        forkCount
        isArchived
        isFork
        isDisabled
        hasIssuesEnabled
        pushedAt
        createdAt
        updatedAt
        primaryLanguage { name }
        licenseInfo { spdxId name }
        repositoryTopics(first: 20) { nodes { topic { name } } }
        openIssues: issues(states: OPEN) { totalCount }
        viewerHasStarred
        ${labelFields.join("\n        ")}
        contributingRoot: object(expression: "HEAD:CONTRIBUTING.md") { __typename ... on Blob { byteSize } }
        contributingGithub: object(expression: "HEAD:.github/CONTRIBUTING.md") { __typename ... on Blob { byteSize } }
        contributingDocs: object(expression: "HEAD:docs/CONTRIBUTING.md") { __typename ... on Blob { byteSize } }
        ${deep ? `recentMergedPRs: pullRequests(states: MERGED, first: 5, orderBy: {field: UPDATED_AT, direction: DESC}) {
          nodes { mergedAt authorAssociation }
        }` : ""}
      }
    `;
  });

  const query = `
    query EnrichRepositories(${variableDeclarations.join(", ")}) {
      ${repoFields.join("\n")}
    }
  `;

  return { query, variables };
}

export class GraphQLApi {
  constructor(private readonly client: GitHubClient) {}

  async getViewer(): Promise<{ login: string }> {
    const data = await this.client.graphql<ViewerResponse>("query { viewer { login } }");
    return data.viewer;
  }

  async getLists(): Promise<GitHubList[]> {
    const lists: GitHubList[] = [];
    let after: string | null = null;

    do {
      const data: ListsResponse = await this.client.graphql<ListsResponse>(
        `query Lists($after: String) {
          viewer {
            lists(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes { id name slug description isPrivate items { totalCount } }
            }
          }
        }`,
        { after },
      );
      const connection = data.viewer.lists;
      lists.push(...connection.nodes.map(mapList));
      after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (after);

    return lists;
  }

  async getListItems(listId: string): Promise<Array<{ nodeId: string; fullName: string }>> {
    const items: Array<{ nodeId: string; fullName: string }> = [];
    let after: string | null = null;

    do {
      const data: ListItemsResponse = await this.client.graphql<ListItemsResponse>(
        `query ListItems($id: ID!, $after: String) {
          node(id: $id) {
            __typename
            ... on UserList {
              items(first: 100, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  __typename
                  ... on Repository { id nameWithOwner }
                }
              }
            }
          }
        }`,
        { id: listId, after },
      );

      if (!data.node?.items) {
        throw new Error(`Could not read items for list ${listId}.`);
      }

      for (const node of data.node.items.nodes) {
        if (node.__typename === "Repository" && node.id && node.nameWithOwner) {
          items.push({ nodeId: node.id, fullName: node.nameWithOwner });
        }
      }
      after = data.node.items.pageInfo.hasNextPage ? data.node.items.pageInfo.endCursor : null;
    } while (after);

    return items;
  }

  async getListMembershipMap(): Promise<Map<string, string[]>> {
    const lists = await this.getLists();
    const membership = new Map<string, string[]>();
    for (const list of lists) {
      const items = await this.getListItems(list.id);
      for (const item of items) {
        const existing = membership.get(item.nodeId) ?? [];
        existing.push(list.id);
        membership.set(item.nodeId, existing);
      }
    }
    return membership;
  }

  async createList(name: string, description: string, isPrivate: boolean): Promise<GitHubList> {
    const data = await this.client.graphql<CreateListResponse>(
      `mutation CreateList($name: String!, $description: String, $isPrivate: Boolean!) {
        createUserList(input: {name: $name, description: $description, isPrivate: $isPrivate}) {
          list { id name slug description isPrivate items { totalCount } }
        }
      }`,
      { name, description, isPrivate },
    );
    return mapList(data.createUserList.list);
  }

  async updateList(
    listId: string,
    update: { name?: string; description?: string; isPrivate?: boolean },
  ): Promise<GitHubList> {
    const data = await this.client.graphql<UpdateListResponse>(
      `mutation UpdateList($listId: ID!, $name: String, $description: String, $isPrivate: Boolean) {
        updateUserList(input: {listId: $listId, name: $name, description: $description, isPrivate: $isPrivate}) {
          list { id name slug description isPrivate items { totalCount } }
        }
      }`,
      { listId, ...update },
    );
    return mapList(data.updateUserList.list);
  }

  async updateListsForItem(itemId: string, listIds: string[]): Promise<{ itemId: string; listIds: string[] }> {
    const data = await this.client.graphql<{ updateUserListsForItem: UpdateListsItemResponse }>(
      `mutation UpdateListsForItem($itemId: ID!, $listIds: [ID!]!) {
        updateUserListsForItem(input: {itemId: $itemId, listIds: $listIds}) {
          item { __typename ... on Repository { id nameWithOwner } }
          lists { id name }
        }
      }`,
      { itemId, listIds },
    );
    return {
      itemId,
      listIds: data.updateUserListsForItem.lists.map((list) => list.id),
    };
  }

  async updateListsForItems(
    items: Array<{ itemId: string; listIds: string[] }>,
  ): Promise<Array<{ itemId: string; success: boolean; error?: string }>> {
    if (items.length === 0) {
      return [];
    }

    const declarations: string[] = [];
    const variables: Record<string, unknown> = {};
    const fields: string[] = [];

    items.forEach((item, index) => {
      declarations.push(`$item${index}: ID!`);
      declarations.push(`$lists${index}: [ID!]!`);
      variables[`item${index}`] = item.itemId;
      variables[`lists${index}`] = item.listIds;
      fields.push(`
        m${index}: updateUserListsForItem(input: {itemId: $item${index}, listIds: $lists${index}}) {
          item { __typename ... on Repository { id nameWithOwner } }
          lists { id name }
        }
      `);
    });

    const query = `
      mutation UpdateListsForItems(${declarations.join(", ")}) {
        ${fields.join("\n")}
      }
    `;

    const response = await this.client.graphqlRaw<Record<string, UpdateListsItemResponse | null>>(
      query,
      variables,
    );

    const errorByAlias = new Map<string, string>();
    for (const error of response.errors ?? []) {
      const alias = error.path?.[0];
      if (typeof alias === "string") {
        errorByAlias.set(alias, error.message);
      }
    }

    return items.map((item, index) => {
      const alias = `m${index}`;
      const error = errorByAlias.get(alias);
      if (error) {
        return { itemId: item.itemId, success: false, error };
      }
      return {
        itemId: item.itemId,
        success: response.data?.[alias] !== undefined && response.data?.[alias] !== null,
        error: response.data?.[alias] === undefined ? "No response for item." : undefined,
      };
    });
  }

  async enrichRepositories(
    repos: Array<{ id: number; nodeId: string; owner: string; name: string }>,
    labels: string[],
    options: { deep?: boolean; batchSize?: number } = {},
  ): Promise<{ repos: Map<string, EnrichedRepo>; errors: string[] }> {
    const enriched = new Map<string, EnrichedRepo>();
    const errors: string[] = [];
    const batchSize = options.batchSize ?? 20;
    const deep = options.deep ?? true;

    for (let offset = 0; offset < repos.length; offset += batchSize) {
      const chunk = repos.slice(offset, offset + batchSize);
      if (chunk.length === 0) {
        continue;
      }

      const { query, variables } = buildEnrichmentQuery(chunk, labels, deep);
      const response = await this.client.graphqlRaw<Record<string, RepositoryNode | null>>(query, variables);

      if (response.errors?.length) {
        errors.push(...response.errors.map((error) => error.message));
      }

      chunk.forEach((repo, index) => {
        const node = response.data?.[`r${index}`];
        if (!node) {
          errors.push(`No enrichment data for ${repo.owner}/${repo.name}.`);
          return;
        }

        enriched.set(repo.nodeId, {
          id: repo.id,
          nodeId: repo.nodeId,
          fullName: node.nameWithOwner,
          htmlUrl: node.url,
          description: node.description,
          language: node.primaryLanguage?.name ?? null,
          stars: node.stargazerCount,
          forks: node.forkCount,
          topics: node.repositoryTopics.nodes.map((topic) => topic.topic.name),
          license: node.licenseInfo?.spdxId ?? node.licenseInfo?.name ?? null,
          pushedAt: node.pushedAt,
          createdAt: node.createdAt,
          updatedAt: node.updatedAt,
          archived: node.isArchived,
          fork: node.isFork,
          disabled: node.isDisabled,
          hasIssues: node.hasIssuesEnabled,
          openIssues: node.openIssues.totalCount,
          goodFirstIssues: countLabel(node, 0),
          helpWantedIssues: countLabel(node, 1),
          firstTimersIssues: countLabel(node, 2),
          upForGrabsIssues: countLabel(node, 3),
          contributingGuide: isBlob(node.contributingRoot) || isBlob(node.contributingGithub) || isBlob(node.contributingDocs),
          recentOutsiderMergedPrs: countOutsiderMergedPrs(node),
          viewerHasStarred: node.viewerHasStarred,
        });
      });
    }

    return { repos: enriched, errors };
  }

  async getStarredCount(): Promise<number> {
    const data = await this.client.graphql<{ viewer: { starredRepositories: { totalCount: number } } }>(
      "query { viewer { starredRepositories { totalCount } } }",
    );
    return data.viewer.starredRepositories.totalCount;
  }
}
