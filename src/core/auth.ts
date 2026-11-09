import { GitHubClient } from "../github/client.ts";
import { RestApi } from "../github/rest.ts";
import { GraphQLApi } from "../github/graphql.ts";
import { getToken, type TokenSource } from "./credentials.ts";
import { UserError } from "./errors.ts";

export interface Apis {
  client: GitHubClient;
  rest: RestApi;
  graphql: GraphQLApi;
  token: string;
  tokenSource: TokenSource;
}

export function createApis(options: { debug?: boolean } = {}): Apis {
  const { token, source } = getToken();
  if (!token) {
    throw new UserError(
      "No GitHub token found. Run `staryu init` to save one, or set GITHUB_TOKEN.",
    );
  }
  const debug = options.debug ?? process.env.STARYU_DEBUG === "1";
  const client = new GitHubClient(token, { debug });
  return {
    client,
    rest: new RestApi(client),
    graphql: new GraphQLApi(client),
    token,
    tokenSource: source,
  };
}
