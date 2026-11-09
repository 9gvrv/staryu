import { USER_AGENT } from "../version.ts";

export interface RateLimitState {
  limit: number | null;
  remaining: number | null;
  resetAt: Date | null;
}

export interface GitHubErrorOptions {
  status?: number;
  documentationUrl?: string;
  errors?: unknown;
  responseBody?: unknown;
}

export class GitHubError extends Error {
  readonly status: number;
  readonly documentationUrl: string | undefined;
  readonly errors: unknown;
  readonly responseBody: unknown;

  constructor(message: string, options: GitHubErrorOptions = {}) {
    super(message);
    this.name = "GitHubError";
    this.status = options.status ?? 0;
    this.documentationUrl = options.documentationUrl;
    this.errors = options.errors;
    this.responseBody = options.responseBody;
  }
}

export class RateLimitError extends GitHubError {
  readonly resetAt: Date | null;

  constructor(message: string, resetAt: Date | null, options: GitHubErrorOptions = {}) {
    super(message, options);
    this.name = "RateLimitError";
    this.resetAt = resetAt;
  }
}

interface GraphQLError {
  message: string;
  type?: string;
  path?: Array<string | number>;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLError[];
}

export interface GitHubClientOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  graphqlUrl?: string;
  maxRetries?: number;
  debug?: boolean;
}

const DEFAULT_BASE_URL = "https://api.github.com";
const DEFAULT_GRAPHQL_URL = "https://api.github.com/graphql";
const API_VERSION = "2022-11-28";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDate(value: string | null): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function headerNumber(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function errorMessageFromBody(body: unknown, fallback: string): string {
  if (typeof body === "string" && body.trim().length > 0) {
    return body;
  }
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim().length > 0) {
      const details = Array.isArray(record.errors)
        ? record.errors
          .map((item) => {
            if (typeof item === "string") {
              return item;
            }
            if (item && typeof item === "object" && typeof (item as Record<string, unknown>).message === "string") {
              return String((item as Record<string, unknown>).message);
            }
            return null;
          })
          .filter((item): item is string => Boolean(item))
          .join("; ")
        : "";
      return details ? `${record.message}: ${details}` : record.message;
    }
  }
  return fallback;
}

export class GitHubClient {
  readonly token: string;
  readonly debug: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly graphqlUrl: string;
  private readonly maxRetries: number;
  lastRateLimit: RateLimitState = { limit: null, remaining: null, resetAt: null };

  constructor(token: string, options: GitHubClientOptions = {}) {
    if (!token.trim()) {
      throw new GitHubError("A GitHub token is required.");
    }
    this.token = token.trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.graphqlUrl = options.graphqlUrl ?? DEFAULT_GRAPHQL_URL;
    this.maxRetries = options.maxRetries ?? 3;
    this.debug = options.debug ?? false;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      "Authorization": `Bearer ${this.token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": USER_AGENT,
      ...extra,
    };
  }

  private updateRateLimit(headers: Headers): void {
    const limit = headerNumber(headers, "x-ratelimit-limit");
    const remaining = headerNumber(headers, "x-ratelimit-remaining");
    const reset = headerNumber(headers, "x-ratelimit-reset");
    this.lastRateLimit = {
      limit,
      remaining,
      resetAt: reset === null ? null : new Date(reset * 1000),
    };
  }

  private async request(
    url: string,
    init: RequestInit,
    options: { allow404?: boolean } = {},
  ): Promise<unknown> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= this.maxRetries) {
      attempt += 1;
      try {
        if (this.debug) {
          const method = init.method ?? "GET";
          console.error(`[staryu:debug] ${method} ${url}`);
        }
        const response = await this.fetchImpl(url, init);
        this.updateRateLimit(response.headers);

        const text = await response.text();
        let body: unknown = text;
        if (text.trim().length > 0) {
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
        } else {
          body = undefined;
        }

        if (response.ok) {
          return body;
        }

        if (response.status === 404 && options.allow404) {
          return null;
        }

        const resetAt = parseDate(response.headers.get("x-ratelimit-reset"));
        const remaining = headerNumber(response.headers, "x-ratelimit-remaining");
        if (response.status === 403 || response.status === 429) {
          if (remaining === 0) {
            throw new RateLimitError(
              `GitHub rate limit exhausted. Resets at ${resetAt?.toISOString() ?? "an unknown time"}.`,
              resetAt,
              { status: response.status, responseBody: body },
            );
          }
        }

        if (response.status >= 500 && attempt <= this.maxRetries) {
          lastError = new GitHubError(
            errorMessageFromBody(body, `GitHub returned HTTP ${response.status}`),
            { status: response.status, responseBody: body },
          );
          await sleep(500 * 2 ** (attempt - 1));
          continue;
        }

        if (response.status === 429 && attempt <= this.maxRetries) {
          const retryAfter = headerNumber(response.headers, "retry-after");
          await sleep((retryAfter ?? 2 ** attempt) * 1000);
          continue;
        }

        const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
        throw new GitHubError(
          errorMessageFromBody(body, `GitHub returned HTTP ${response.status}`),
          {
            status: response.status,
            documentationUrl: typeof record.documentation_url === "string" ? record.documentation_url : undefined,
            errors: record.errors,
            responseBody: body,
          },
        );
      } catch (error) {
        if (error instanceof RateLimitError || error instanceof GitHubError) {
          if (error instanceof GitHubError && error.status >= 500 && attempt <= this.maxRetries) {
            lastError = error;
            await sleep(500 * 2 ** (attempt - 1));
            continue;
          }
          throw error;
        }
        lastError = error;
        if (attempt <= this.maxRetries) {
          await sleep(500 * 2 ** (attempt - 1));
          continue;
        }
        throw new GitHubError(
          `Network error while contacting GitHub: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new GitHubError("GitHub request failed for an unknown reason.");
  }

  async rest<T>(path: string, init: RequestInit = {}, options: { allow404?: boolean } = {}): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
    const headers = this.headers(init.body ? { "Content-Type": "application/json" } : undefined);
    const body = await this.request(url, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } }, options);
    return body as T;
  }

  async restWithHeaders<T>(path: string, init: RequestInit = {}): Promise<{ data: T; headers: Headers }> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
    const headers = this.headers(init.body ? { "Content-Type": "application/json" } : undefined);
    const response = await this.fetchImpl(url, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } });
    this.updateRateLimit(response.headers);
    const text = await response.text();
    const data = text.trim().length > 0 ? JSON.parse(text) as T : undefined as T;
    if (!response.ok) {
      throw new GitHubError(`GitHub returned HTTP ${response.status}`, {
        status: response.status,
        responseBody: data,
      });
    }
    return { data, headers: response.headers };
  }

  async graphqlRaw<T>(query: string, variables: Record<string, unknown> = {}): Promise<GraphQLResponse<T>> {
    const body = await this.request(this.graphqlUrl, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ query, variables }),
    });
    return (body ?? {}) as GraphQLResponse<T>;
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const response = await this.graphqlRaw<T>(query, variables);
    if (response.errors?.length) {
      throw new GitHubError(
        `GitHub GraphQL error: ${response.errors.map((error) => error.message).join("; ")}`,
        { errors: response.errors, responseBody: response },
      );
    }
    if (response.data === undefined) {
      throw new GitHubError("GitHub GraphQL returned no data.", { responseBody: response });
    }
    return response.data;
  }

  async getScopes(): Promise<string[] | null> {
    const { headers } = await this.restWithHeaders<unknown>("/user");
    const scopes = headers.get("x-oauth-scopes");
    if (scopes === null) {
      return null;
    }
    return scopes.split(",").map((scope) => scope.trim()).filter(Boolean);
  }
}
