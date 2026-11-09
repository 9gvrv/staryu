import type { GitHubClient } from "./client.ts";
import type { GitHubSearchRepo, GitHubSearchResponse, GitHubUser } from "../types.ts";

export interface SearchOptions {
  sort?: "stars" | "updated" | "best-match";
  order?: "desc" | "asc";
  perPage?: number;
  page?: number;
}

export interface ListStarredOptions {
  perPage?: number;
  maxPages?: number;
  onPage?: (page: number, repos: GitHubSearchRepo[]) => void;
}

export class RestApi {
  constructor(private readonly client: GitHubClient) {}

  getUser(): Promise<GitHubUser> {
    return this.client.rest<GitHubUser>("/user");
  }

  searchRepositories(query: string, options: SearchOptions = {}): Promise<GitHubSearchResponse> {
    const params = new URLSearchParams({
      q: query,
      per_page: String(options.perPage ?? 50),
      page: String(options.page ?? 1),
    });
    if (options.sort && options.sort !== "best-match") {
      params.set("sort", options.sort);
      params.set("order", options.order ?? "desc");
    }
    return this.client.rest<GitHubSearchResponse>(`/search/repositories?${params.toString()}`);
  }

  listStarredPage(page = 1, perPage = 100): Promise<GitHubSearchRepo[]> {
    const params = new URLSearchParams({
      per_page: String(perPage),
      page: String(page),
    });
    return this.client.rest<GitHubSearchRepo[]>(`/user/starred?${params.toString()}`);
  }

  async listStarredAll(options: ListStarredOptions = {}): Promise<GitHubSearchRepo[]> {
    const perPage = options.perPage ?? 100;
    const maxPages = options.maxPages ?? 100;
    const all: GitHubSearchRepo[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const repos = await this.listStarredPage(page, perPage);
      if (repos.length === 0) {
        break;
      }
      all.push(...repos);
      options.onPage?.(page, repos);
      if (repos.length < perPage) {
        break;
      }
    }
    return all;
  }

  async isStarred(owner: string, repo: string): Promise<boolean> {
    const result = await this.client.rest<unknown>(
      `/user/starred/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { method: "GET" },
      { allow404: true },
    );
    return result !== null;
  }

  async star(owner: string, repo: string): Promise<void> {
    await this.client.rest<unknown>(
      `/user/starred/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { method: "PUT" },
    );
  }

  async unstar(owner: string, repo: string): Promise<void> {
    await this.client.rest<unknown>(
      `/user/starred/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { method: "DELETE" },
    );
  }

  getRepository(owner: string, repo: string): Promise<GitHubSearchRepo> {
    return this.client.rest<GitHubSearchRepo>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    );
  }
}
