export type StarredVia = "user" | "tool" | "unknown";
export type ListAddedVia = "user" | "tool" | "unknown";
export type Intent = "use" | "contribute" | "both";
export type RunStatus = "running" | "completed" | "partial" | "failed" | "undone";
export type CandidateOutcome =
  | "pending"
  | "starred"
  | "already_starred"
  | "list_added"
  | "skipped"
  | "failed";
export type ActionType = "star" | "unstar" | "list_add" | "list_remove";

export interface RepoRecord {
  id: number;
  nodeId: string;
  fullName: string;
  owner: string;
  name: string;
  htmlUrl: string;
  description: string | null;
  language: string | null;
  stars: number;
  forks: number;
  topics: string[];
  license: string | null;
  pushedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  archived: boolean;
  fork: boolean;
  disabled: boolean;
  hasIssues: boolean;
  openIssues: number;
  goodFirstIssues: number;
  helpWantedIssues: number;
  firstTimersIssues: number;
  upForGrabsIssues: number;
  contributingGuide: boolean;
  recentOutsiderMergedPrs: number;
  starredVia: StarredVia;
  listAddedVia: ListAddedVia;
  firstSeenAt: string;
  lastSeenAt: string;
  lastActionAt: string | null;
}

export interface RepoReason {
  code: string;
  label: string;
  points: number;
}

export interface Candidate {
  repo: RepoRecord;
  score: number;
  reasons: RepoReason[];
  intent: Intent;
  sourceIntent: Intent;
}

export interface CandidateRow {
  runId: number;
  repoId: number;
  score: number;
  reasons: RepoReason[];
  intent: Intent;
  selected: boolean;
  outcome: CandidateOutcome;
  error: string | null;
}

export interface CandidateWithRepo extends CandidateRow {
  repo: RepoRecord;
}

export interface SearchQuery {
  id: string;
  q: string;
  sort: "stars" | "updated" | "best-match";
  intent: Intent;
}

export interface GitHubUser {
  login: string;
  name: string | null;
  avatar_url?: string;
  html_url?: string;
  public_repos?: number;
  followers?: number;
}

export interface GitHubSearchRepo {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  owner: { login: string };
  html_url: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  topics?: string[];
  license: { key?: string; name: string; spdx_id: string | null } | null;
  pushed_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  archived: boolean;
  fork: boolean;
  disabled?: boolean;
  has_issues?: boolean;
  default_branch?: string;
}

export interface GitHubSearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: GitHubSearchRepo[];
}

export interface GitHubList {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isPrivate: boolean;
  itemCount: number;
}

export interface RunRecord {
  id: number;
  command: string;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  configJson: string;
  summaryJson: string | null;
}

export interface ActionRecord {
  id: number;
  runId: number;
  repoId: number;
  action: ActionType;
  before: unknown;
  after: unknown;
  success: boolean;
  error: string | null;
  createdAt: string;
}

export interface EnrichedRepo {
  nodeId: string;
  fullName: string;
  id: number;
  htmlUrl: string;
  description: string | null;
  language: string | null;
  stars: number;
  forks: number;
  topics: string[];
  license: string | null;
  pushedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  archived: boolean;
  fork: boolean;
  disabled: boolean;
  hasIssues: boolean;
  openIssues: number;
  goodFirstIssues: number;
  helpWantedIssues: number;
  firstTimersIssues: number;
  upForGrabsIssues: number;
  contributingGuide: boolean;
  recentOutsiderMergedPrs: number;
  viewerHasStarred?: boolean;
}
