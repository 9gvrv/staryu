import pc from "picocolors";
import type { CandidateWithRepo, Intent } from "../types.ts";

export function formatNumber(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(value);
}

export function truncate(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }
  if (width <= 1) {
    return value.slice(0, width);
  }
  return `${value.slice(0, width - 1)}…`;
}

export function intentLabel(intent: Intent): string {
  switch (intent) {
    case "use":
      return "use";
    case "contribute":
      return "contribute";
    case "both":
      return "use + contribute";
  }
}

export interface TableRow {
  index: string;
  repo: string;
  stars: string;
  language: string;
  score: string;
  intent: string;
  why: string;
  color?: (value: string) => string;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

export function renderTable(rows: TableRow[], colorize = true): string {
  if (rows.length === 0) {
    return "";
  }

  const headers: TableRow = {
    index: "#",
    repo: "repository",
    stars: "stars",
    language: "language",
    score: "score",
    intent: "intent",
    why: "why",
  };

  const all = [headers, ...rows];
  const widths = {
    index: Math.max(...all.map((row) => row.index.length)),
    repo: Math.max(...all.map((row) => row.repo.length)),
    stars: Math.max(...all.map((row) => row.stars.length)),
    language: Math.max(...all.map((row) => row.language.length)),
    score: Math.max(...all.map((row) => row.score.length)),
    intent: Math.max(...all.map((row) => row.intent.length)),
    why: Math.max(...all.map((row) => row.why.length)),
  };

  const line = (row: TableRow, isHeader = false): string => {
    const cells = [
      pad(row.index, widths.index),
      pad(row.repo, widths.repo),
      pad(row.stars, widths.stars),
      pad(row.language, widths.language),
      pad(row.score, widths.score),
      pad(row.intent, widths.intent),
      pad(row.why, widths.why),
    ];
    const text = cells.join("  ").replace(/\s+$/, "");
    if (isHeader) {
      return colorize ? pc.bold(pc.dim(text)) : text;
    }
    if (colorize && row.color) {
      return row.color(text);
    }
    return text;
  };

  const divider = widths.index + widths.repo + widths.stars + widths.language +
    widths.score + widths.intent + widths.why + 12;

  return [
    line(headers, true),
    colorize ? pc.dim("─".repeat(Math.min(divider, 120))) : "-".repeat(Math.min(divider, 120)),
    ...rows.map((row) => line(row)),
  ].join("\n");
}

export function candidateRows(candidates: CandidateWithRepo[], offset = 0): TableRow[] {
  return candidates.map((candidate, index) => {
    const byCode = new Map(candidate.reasons.map((reason) => [reason.code, reason]));
    const preferred = candidate.intent === "contribute"
      ? ["good-first", "help-wanted", "first-timers", "up-for-grabs", "contributing", "merged-prs", "language", "stars"]
      : ["language", "topic", "stars", "active", "merged-prs", "contributing", "good-first", "help-wanted"];
    const picked = preferred
      .map((code) => byCode.get(code))
      .filter((reason): reason is NonNullable<typeof reason> => Boolean(reason))
      .slice(0, 2);
    const reasons = picked.length > 0 ? picked : candidate.reasons.slice(0, 2);
    const why = reasons.map((reason) => reason.label).join(", ");
    return {
      index: String(offset + index + 1),
      repo: truncate(candidate.repo.fullName, 40),
      stars: formatNumber(candidate.repo.stars),
      language: truncate(candidate.repo.language ?? "—", 14),
      score: candidate.score.toFixed(1),
      intent: intentLabel(candidate.intent),
      why: truncate(why || "—", 46),
      color: candidate.repo.archived ? pc.dim : undefined,
    };
  });
}

export function renderCandidates(candidates: CandidateWithRepo[]): string {
  return renderTable(candidateRows(candidates));
}
