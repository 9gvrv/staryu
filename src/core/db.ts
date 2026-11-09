import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { ensureDir, getAppPaths } from "./paths.ts";
import type {
  ActionRecord,
  ActionType,
  Candidate,
  CandidateRow,
  CandidateWithRepo,
  ListAddedVia,
  RepoRecord,
  RunRecord,
  RunStatus,
  StarredVia,
} from "../types.ts";

interface RepoRow {
  id: number;
  node_id: string;
  full_name: string;
  owner: string;
  name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  stars: number;
  forks: number;
  topics: string;
  license: string | null;
  pushed_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  archived: number;
  fork: number;
  disabled: number;
  has_issues: number;
  open_issues: number;
  good_first_issues: number;
  help_wanted_issues: number;
  first_timers_issues: number;
  up_for_grabs_issues: number;
  contributing_guide: number;
  recent_outsider_merged_prs: number;
  starred_via: StarredVia;
  list_added_via: ListAddedVia;
  first_seen_at: string;
  last_seen_at: string;
  last_action_at: string | null;
}

interface RunRow {
  id: number;
  command: string;
  started_at: string;
  finished_at: string | null;
  status: RunStatus;
  config_json: string;
  summary_json: string | null;
}

interface CandidateJoinRow {
  run_id: number;
  repo_id: number;
  score: number;
  reasons: string;
  intent: CandidateRow["intent"];
  selected: number;
  outcome: CandidateRow["outcome"];
  error: string | null;
}

interface ActionRow {
  id: number;
  run_id: number;
  repo_id: number;
  action: ActionType;
  before_json: string;
  after_json: string;
  success: number;
  error: string | null;
  created_at: string;
}

const SCHEMA_VERSION = 1;

function safeJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function rowToRepo(row: RepoRow): RepoRecord {
  return {
    id: row.id,
    nodeId: row.node_id,
    fullName: row.full_name,
    owner: row.owner,
    name: row.name,
    htmlUrl: row.html_url,
    description: row.description,
    language: row.language,
    stars: row.stars,
    forks: row.forks,
    topics: safeJsonArray(row.topics),
    license: row.license,
    pushedAt: row.pushed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: row.archived === 1,
    fork: row.fork === 1,
    disabled: row.disabled === 1,
    hasIssues: row.has_issues === 1,
    openIssues: row.open_issues,
    goodFirstIssues: row.good_first_issues,
    helpWantedIssues: row.help_wanted_issues,
    firstTimersIssues: row.first_timers_issues,
    upForGrabsIssues: row.up_for_grabs_issues,
    contributingGuide: row.contributing_guide === 1,
    recentOutsiderMergedPrs: row.recent_outsider_merged_prs,
    starredVia: row.starred_via,
    listAddedVia: row.list_added_via,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastActionAt: row.last_action_at,
  };
}

function rowToRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    command: row.command,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    configJson: row.config_json,
    summaryJson: row.summary_json,
  };
}

function rowToAction(row: ActionRow): ActionRecord {
  return {
    id: row.id,
    runId: row.run_id,
    repoId: row.repo_id,
    action: row.action,
    before: JSON.parse(row.before_json) as unknown,
    after: JSON.parse(row.after_json) as unknown,
    success: row.success === 1,
    error: row.error,
    createdAt: row.created_at,
  };
}

export function openDatabase(dbFile = getAppPaths().dbFile): DatabaseSync {
  ensureDir(dirname(dbFile));
  const db = new DatabaseSync(dbFile);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id INTEGER PRIMARY KEY,
      node_id TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      html_url TEXT NOT NULL,
      description TEXT,
      language TEXT,
      stars INTEGER NOT NULL DEFAULT 0,
      forks INTEGER NOT NULL DEFAULT 0,
      topics TEXT NOT NULL DEFAULT '[]',
      license TEXT,
      pushed_at TEXT,
      created_at TEXT,
      updated_at TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      fork INTEGER NOT NULL DEFAULT 0,
      disabled INTEGER NOT NULL DEFAULT 0,
      has_issues INTEGER NOT NULL DEFAULT 0,
      open_issues INTEGER NOT NULL DEFAULT 0,
      good_first_issues INTEGER NOT NULL DEFAULT 0,
      help_wanted_issues INTEGER NOT NULL DEFAULT 0,
      first_timers_issues INTEGER NOT NULL DEFAULT 0,
      up_for_grabs_issues INTEGER NOT NULL DEFAULT 0,
      contributing_guide INTEGER NOT NULL DEFAULT 0,
      recent_outsider_merged_prs INTEGER NOT NULL DEFAULT 0,
      starred_via TEXT NOT NULL DEFAULT 'unknown',
      list_added_via TEXT NOT NULL DEFAULT 'unknown',
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_action_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_repos_full_name ON repos(full_name);
    CREATE INDEX IF NOT EXISTS idx_repos_starred_via ON repos(starred_via);
    CREATE INDEX IF NOT EXISTS idx_repos_list_added_via ON repos(list_added_via);

    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      command TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      config_json TEXT NOT NULL,
      summary_json TEXT
    );

    CREATE TABLE IF NOT EXISTS run_candidates (
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      repo_id INTEGER NOT NULL REFERENCES repos(id),
      score REAL NOT NULL,
      reasons TEXT NOT NULL,
      intent TEXT NOT NULL,
      selected INTEGER NOT NULL DEFAULT 0,
      outcome TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      PRIMARY KEY (run_id, repo_id)
    );

    CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      repo_id INTEGER NOT NULL REFERENCES repos(id),
      action TEXT NOT NULL,
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      success INTEGER NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_actions_run ON actions(run_id);
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
}

export function upsertRepo(db: DatabaseSync, repo: RepoRecord): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO repos (
      id, node_id, full_name, owner, name, html_url, description, language,
      stars, forks, topics, license, pushed_at, created_at, updated_at,
      archived, fork, disabled, has_issues, open_issues,
      starred_via, list_added_via, first_seen_at, last_seen_at, last_action_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      node_id = excluded.node_id,
      full_name = excluded.full_name,
      owner = excluded.owner,
      name = excluded.name,
      html_url = excluded.html_url,
      description = excluded.description,
      language = excluded.language,
      stars = excluded.stars,
      forks = excluded.forks,
      topics = excluded.topics,
      license = excluded.license,
      pushed_at = excluded.pushed_at,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      archived = excluded.archived,
      fork = excluded.fork,
      disabled = excluded.disabled,
      has_issues = excluded.has_issues,
      open_issues = excluded.open_issues,
      starred_via = CASE
        WHEN repos.starred_via != 'unknown' THEN repos.starred_via
        ELSE excluded.starred_via
      END,
      list_added_via = CASE
        WHEN repos.list_added_via != 'unknown' THEN repos.list_added_via
        ELSE excluded.list_added_via
      END,
      last_seen_at = excluded.last_seen_at,
      last_action_at = COALESCE(excluded.last_action_at, repos.last_action_at)
  `).run(
    repo.id,
    repo.nodeId,
    repo.fullName,
    repo.owner,
    repo.name,
    repo.htmlUrl,
    repo.description,
    repo.language,
    repo.stars,
    repo.forks,
    JSON.stringify(repo.topics),
    repo.license,
    repo.pushedAt,
    repo.createdAt,
    repo.updatedAt,
    repo.archived ? 1 : 0,
    repo.fork ? 1 : 0,
    repo.disabled ? 1 : 0,
    repo.hasIssues ? 1 : 0,
    repo.openIssues,
    repo.starredVia,
    repo.listAddedVia,
    repo.firstSeenAt || now,
    repo.lastSeenAt || now,
    repo.lastActionAt,
  );
}

export function updateRepoEnrichment(db: DatabaseSync, repo: RepoRecord): void {
  db.prepare(`
    UPDATE repos SET
      good_first_issues = ?,
      help_wanted_issues = ?,
      first_timers_issues = ?,
      up_for_grabs_issues = ?,
      contributing_guide = ?,
      recent_outsider_merged_prs = ?,
      open_issues = ?,
      has_issues = ?,
      last_seen_at = ?
    WHERE node_id = ?
  `).run(
    repo.goodFirstIssues,
    repo.helpWantedIssues,
    repo.firstTimersIssues,
    repo.upForGrabsIssues,
    repo.contributingGuide ? 1 : 0,
    repo.recentOutsiderMergedPrs,
    repo.openIssues,
    repo.hasIssues ? 1 : 0,
    new Date().toISOString(),
    repo.nodeId,
  );
}

export function getRepoByNodeId(db: DatabaseSync, nodeId: string): RepoRecord | null {
  const row = db.prepare("SELECT * FROM repos WHERE node_id = ?").get(nodeId) as RepoRow | undefined;
  return row ? rowToRepo(row) : null;
}

export function getRepoByFullName(db: DatabaseSync, fullName: string): RepoRecord | null {
  const row = db.prepare("SELECT * FROM repos WHERE full_name = ?").get(fullName) as RepoRow | undefined;
  return row ? rowToRepo(row) : null;
}

export function getRepoById(db: DatabaseSync, id: number): RepoRecord | null {
  const row = db.prepare("SELECT * FROM repos WHERE id = ?").get(id) as RepoRow | undefined;
  return row ? rowToRepo(row) : null;
}

export function listStarredRepos(db: DatabaseSync): RepoRecord[] {
  const rows = db.prepare("SELECT * FROM repos WHERE starred_via != 'unknown' ORDER BY full_name").all() as unknown as RepoRow[];
  return rows.map(rowToRepo);
}

export function listReposInList(db: DatabaseSync): RepoRecord[] {
  const rows = db.prepare("SELECT * FROM repos WHERE list_added_via != 'unknown' ORDER BY full_name").all() as unknown as RepoRow[];
  return rows.map(rowToRepo);
}

export function markRepoStarred(db: DatabaseSync, nodeId: string, via: "user" | "tool"): void {
  db.prepare("UPDATE repos SET starred_via = ?, last_action_at = ? WHERE node_id = ?")
    .run(via, new Date().toISOString(), nodeId);
}

export function markRepoUnstarred(db: DatabaseSync, nodeId: string): void {
  db.prepare("UPDATE repos SET starred_via = 'unknown', last_action_at = ? WHERE node_id = ?")
    .run(new Date().toISOString(), nodeId);
}

export function markRepoListAdded(db: DatabaseSync, nodeId: string, via: "user" | "tool"): void {
  db.prepare("UPDATE repos SET list_added_via = ?, last_action_at = ? WHERE node_id = ?")
    .run(via, new Date().toISOString(), nodeId);
}

export function markRepoListRemoved(db: DatabaseSync, nodeId: string): void {
  db.prepare("UPDATE repos SET list_added_via = 'unknown', last_action_at = ? WHERE node_id = ?")
    .run(new Date().toISOString(), nodeId);
}

export function createRun(db: DatabaseSync, command: string, config: unknown): number {
  const result = db.prepare(
    "INSERT INTO runs (command, started_at, status, config_json) VALUES (?, ?, 'running', ?)",
  ).run(command, new Date().toISOString(), JSON.stringify(config));
  return Number(result.lastInsertRowid);
}

export function finishRun(
  db: DatabaseSync,
  runId: number,
  status: Exclude<RunStatus, "running">,
  summary?: unknown,
): void {
  db.prepare("UPDATE runs SET finished_at = ?, status = ?, summary_json = ? WHERE id = ?")
    .run(new Date().toISOString(), status, summary === undefined ? null : JSON.stringify(summary), runId);
}

export function getRun(db: DatabaseSync, runId: number): RunRecord | null {
  const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
  return row ? rowToRun(row) : null;
}

export function markRunUndone(db: DatabaseSync, runId: number): void {
  db.prepare("UPDATE runs SET status = 'undone' WHERE id = ?").run(runId);
}

export function getLatestRun(
  db: DatabaseSync,
  options: { commands?: string[]; statuses?: RunStatus[] } = {},
): RunRecord | null {
  const clauses: string[] = [];
  const values: string[] = [];
  if (options.commands?.length) {
    clauses.push(`command IN (${options.commands.map(() => "?").join(", ")})`);
    values.push(...options.commands);
  }
  if (options.statuses?.length) {
    clauses.push(`status IN (${options.statuses.map(() => "?").join(", ")})`);
    values.push(...options.statuses);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const row = db.prepare(`SELECT * FROM runs ${where} ORDER BY id DESC LIMIT 1`).get(...values) as RunRow | undefined;
  return row ? rowToRun(row) : null;
}

export function saveCandidates(db: DatabaseSync, runId: number, candidates: Candidate[]): void {
  const insert = db.prepare(`
    INSERT INTO run_candidates (run_id, repo_id, score, reasons, intent, selected, outcome, error)
    VALUES (?, ?, ?, ?, ?, 0, 'pending', NULL)
    ON CONFLICT(run_id, repo_id) DO UPDATE SET
      score = excluded.score,
      reasons = excluded.reasons,
      intent = excluded.intent
  `);
  db.exec("BEGIN");
  try {
    for (const candidate of candidates) {
      insert.run(
        runId,
        candidate.repo.id,
        candidate.score,
        JSON.stringify(candidate.reasons),
        candidate.intent,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getCandidates(db: DatabaseSync, runId: number): CandidateWithRepo[] {
  const rows = db.prepare(`
    SELECT rc.run_id, rc.repo_id, rc.score, rc.reasons, rc.intent, rc.selected, rc.outcome, rc.error,
           r.*
    FROM run_candidates rc
    JOIN repos r ON r.id = rc.repo_id
    WHERE rc.run_id = ?
    ORDER BY rc.score DESC, r.stars DESC
  `).all(runId) as unknown as Array<CandidateJoinRow & RepoRow>;
  return rows.map((row) => ({
    runId: row.run_id,
    repoId: row.repo_id,
    score: row.score,
    reasons: JSON.parse(row.reasons) as CandidateRow["reasons"],
    intent: row.intent,
    selected: row.selected === 1,
    outcome: row.outcome,
    error: row.error,
    repo: rowToRepo(row),
  }));
}

export function updateCandidate(
  db: DatabaseSync,
  runId: number,
  repoId: number,
  update: { selected?: boolean; outcome?: CandidateRow["outcome"]; error?: string | null },
): void {
  const fields: string[] = [];
  const values: Array<string | number | null> = [];
  if (update.selected !== undefined) {
    fields.push("selected = ?");
    values.push(update.selected ? 1 : 0);
  }
  if (update.outcome !== undefined) {
    fields.push("outcome = ?");
    values.push(update.outcome);
  }
  if (update.error !== undefined) {
    fields.push("error = ?");
    values.push(update.error);
  }
  if (fields.length === 0) {
    return;
  }
  values.push(runId, repoId);
  db.prepare(`UPDATE run_candidates SET ${fields.join(", ")} WHERE run_id = ? AND repo_id = ?`)
    .run(...values);
}

export function recordAction(
  db: DatabaseSync,
  runId: number,
  repoId: number,
  action: ActionType,
  before: unknown,
  after: unknown,
  success: boolean,
  error?: string | null,
): void {
  db.prepare(`
    INSERT INTO actions (run_id, repo_id, action, before_json, after_json, success, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    repoId,
    action,
    JSON.stringify(before ?? null),
    JSON.stringify(after ?? null),
    success ? 1 : 0,
    error ?? null,
    new Date().toISOString(),
  );
}

export function getActions(db: DatabaseSync, runId: number): ActionRecord[] {
  const rows = db.prepare("SELECT * FROM actions WHERE run_id = ? ORDER BY id ASC").all(runId) as unknown as ActionRow[];
  return rows.map(rowToAction);
}

export interface DbStats {
  repos: number;
  starred: number;
  listed: number;
  runs: number;
  lastRun: RunRecord | null;
}

export function getStats(db: DatabaseSync): DbStats {
  const repos = (db.prepare("SELECT COUNT(*) AS count FROM repos").get() as { count: number }).count;
  const starred = (db.prepare("SELECT COUNT(*) AS count FROM repos WHERE starred_via != 'unknown'").get() as { count: number }).count;
  const listed = (db.prepare("SELECT COUNT(*) AS count FROM repos WHERE list_added_via != 'unknown'").get() as { count: number }).count;
  const runs = (db.prepare("SELECT COUNT(*) AS count FROM runs").get() as { count: number }).count;
  const lastRun = getLatestRun(db);
  return { repos, starred, listed, runs, lastRun };
}

export function pruneRuns(db: DatabaseSync, keep = 30): void {
  db.prepare(`
    DELETE FROM runs
    WHERE id NOT IN (
      SELECT id FROM runs ORDER BY id DESC LIMIT ?
    )
  `).run(keep);
}
