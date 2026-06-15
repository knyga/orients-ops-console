/**
 * Pure aggregation for GitHub dev reporting.
 *
 * Consumes the raw OrgActivity fetched by lib/githubClient (commits on the
 * default branch + pull requests across the org's active repos) and produces a
 * per-user contributor leaderboard and a most-active-repositories ranking, each
 * carrying commits / additions / deletions / net lines / PRs opened / merged.
 *
 * Policy / invariants:
 *  - Commits are PRE-WINDOWED by the fetch (history since/until), so every
 *    commit record is already in-period; this module sums them as-is.
 *  - Pull requests arrive as an updatedAt-ordered superset, so this module
 *    buckets them itself: a PR counts as "opened" when createdAt is in-period
 *    and "merged" when mergedAt is in-period — the two windows are independent.
 *  - Contributors are grouped by GitHub login; a commit with no linked account
 *    falls back to its author name and is flagged `unlinked`.
 *  - Bot accounts (GitHub Bot type / "[bot]" login) are tallied but flagged,
 *    sorted after humans, and excluded from the human contributor count.
 *  - Day boundaries are UTC (start 00:00:00Z .. end 23:59:59.999Z) — unlike the
 *    field-ops Kyiv boundary; engineering activity has no field-timezone basis.
 *
 * No React / Next imports — pure and unit-tested.
 */
import type { OrgActivity } from "./githubClient";

export interface ContributorRow {
  /** Stable grouping key: `login:<login>`, or `name:<authorName>` if unlinked. */
  key: string;
  login: string | null;
  displayName: string;
  isBot: boolean;
  /** True when grouped from commits with no linked GitHub account. */
  unlinked: boolean;
  commits: number;
  additions: number;
  deletions: number;
  net: number;
  prsOpened: number;
  prsMerged: number;
}

export interface RepoRow {
  repo: string;
  commits: number;
  additions: number;
  deletions: number;
  net: number;
  prsOpened: number;
  prsMerged: number;
  /** Composite ranking signal: commits + prsOpened + prsMerged. */
  activityScore: number;
}

export interface DevStatsTotals {
  repos: number;
  /** Human (non-bot) contributor count. */
  contributors: number;
  commits: number;
  additions: number;
  deletions: number;
  net: number;
  prsOpened: number;
  prsMerged: number;
}

export interface DevStatsSummary {
  org: string;
  period: { start: string; end: string };
  contributors: ContributorRow[];
  repos: RepoRow[];
  totals: DevStatsTotals;
}

/** Inclusive UTC epoch-ms bounds for a YYYY-MM-DD period. */
function periodBounds(start: string, end: string): { from: number; to: number } {
  return {
    from: Date.parse(`${start}T00:00:00.000Z`),
    to: Date.parse(`${end}T23:59:59.999Z`),
  };
}

function inPeriod(iso: string | null, from: number, to: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t >= from && t <= to;
}

export function buildContributorLeaderboard(
  activity: OrgActivity,
): ContributorRow[] {
  const { from, to } = periodBounds(activity.start, activity.end);
  const rows = new Map<string, ContributorRow>();

  const ensure = (
    login: string | null,
    name: string,
    isBot: boolean,
  ): ContributorRow => {
    const key = login ? `login:${login}` : `name:${name}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        key,
        login,
        displayName: login ?? name,
        isBot,
        unlinked: !login,
        commits: 0,
        additions: 0,
        deletions: 0,
        net: 0,
        prsOpened: 0,
        prsMerged: 0,
      };
      rows.set(key, row);
    }
    // A later record may reveal bot-ness an earlier one lacked.
    row.isBot = row.isBot || isBot;
    return row;
  };

  for (const c of activity.commits) {
    const row = ensure(c.authorLogin, c.authorName, c.isBot);
    row.commits += 1;
    row.additions += c.additions;
    row.deletions += c.deletions;
    row.net += c.additions - c.deletions;
  }

  for (const p of activity.pullRequests) {
    const row = ensure(p.authorLogin, p.authorName, p.isBot);
    if (inPeriod(p.createdAt, from, to)) row.prsOpened += 1;
    if (inPeriod(p.mergedAt, from, to)) row.prsMerged += 1;
  }

  return [...rows.values()].sort(compareContributors);
}

function compareContributors(a: ContributorRow, b: ContributorRow): number {
  if (a.isBot !== b.isBot) return a.isBot ? 1 : -1; // humans first
  if (b.commits !== a.commits) return b.commits - a.commits;
  if (b.net !== a.net) return b.net - a.net;
  return a.displayName.localeCompare(b.displayName);
}

export function buildRepoRanking(activity: OrgActivity): RepoRow[] {
  const { from, to } = periodBounds(activity.start, activity.end);
  const rows = new Map<string, RepoRow>();

  const ensure = (repo: string): RepoRow => {
    let row = rows.get(repo);
    if (!row) {
      row = {
        repo,
        commits: 0,
        additions: 0,
        deletions: 0,
        net: 0,
        prsOpened: 0,
        prsMerged: 0,
        activityScore: 0,
      };
      rows.set(repo, row);
    }
    return row;
  };

  // Seed every active repo so zero-activity repos still appear in the ranking.
  for (const repo of activity.repos) ensure(repo.name);

  for (const c of activity.commits) {
    const row = ensure(c.repo);
    row.commits += 1;
    row.additions += c.additions;
    row.deletions += c.deletions;
    row.net += c.additions - c.deletions;
  }

  for (const p of activity.pullRequests) {
    const row = ensure(p.repo);
    if (inPeriod(p.createdAt, from, to)) row.prsOpened += 1;
    if (inPeriod(p.mergedAt, from, to)) row.prsMerged += 1;
  }

  for (const row of rows.values()) {
    row.activityScore = row.commits + row.prsOpened + row.prsMerged;
  }

  return [...rows.values()].sort(compareRepos);
}

function compareRepos(a: RepoRow, b: RepoRow): number {
  if (b.activityScore !== a.activityScore)
    return b.activityScore - a.activityScore;
  if (b.commits !== a.commits) return b.commits - a.commits;
  return a.repo.localeCompare(b.repo);
}

export function summarize(activity: OrgActivity): DevStatsSummary {
  const contributors = buildContributorLeaderboard(activity);
  const repos = buildRepoRanking(activity);

  const totals = repos.reduce<DevStatsTotals>(
    (t, r) => {
      t.commits += r.commits;
      t.additions += r.additions;
      t.deletions += r.deletions;
      t.net += r.net;
      t.prsOpened += r.prsOpened;
      t.prsMerged += r.prsMerged;
      return t;
    },
    {
      repos: activity.repos.length,
      contributors: contributors.filter((c) => !c.isBot).length,
      commits: 0,
      additions: 0,
      deletions: 0,
      net: 0,
      prsOpened: 0,
      prsMerged: 0,
    },
  );

  return {
    org: activity.org,
    period: { start: activity.start, end: activity.end },
    contributors,
    repos,
    totals,
  };
}
