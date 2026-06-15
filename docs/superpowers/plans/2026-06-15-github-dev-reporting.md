# GitHub Dev Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Report GitHub engineering activity (commits, PRs opened/merged, code landed, most-active repos) across the `orients-ai` org for a chosen date range, exposed through **both** a dashboard page and a CLI over one shared code path.

**Architecture:** A shared, pure-ish GraphQL client (`lib/githubClient.ts`, token injected, no `server-only`) fetches commits-on-default-branch + pull requests for every active repo. A pure, unit-tested module (`lib/devStats.ts`) aggregates that into a contributor leaderboard and a repo ranking. The web path adds a thin `server-only` wrapper (`lib/github.ts`) + API route + client page; the CLI (`scripts/dev-report.ts`) calls the shared client directly. `server-only` lives only in the wrapper because its default export throws in a plain Node process, which would break the CLI.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, Tailwind v4, Vitest, GitHub GraphQL API v4, `tsx` for the CLI.

---

## File Structure

- **Create `lib/githubClient.ts`** — shared GraphQL client + all raw record types (`RepoRecord`, `CommitRecord`, `PullRequestRecord`, `OrgActivity`, `GitHubError`, `fetchOrgActivity`). No `server-only`, no env reads.
- **Create `lib/devStats.ts`** — pure aggregation: `buildContributorLeaderboard`, `buildRepoRanking`, `summarize`, and the row/summary types. Imports only types from `githubClient`.
- **Create `lib/devStats.test.ts`** — Vitest unit tests for the pure logic.
- **Create `lib/github.ts`** — `server-only` wrapper: reads `GH_ACCESS_TOKEN`, exposes `ORG` + `fetchOrgActivityForPeriod`. Web-only.
- **Create `app/api/github/route.ts`** — `GET /api/github?start=&end=`, validates dates, returns `{ activity }`.
- **Create `components/ContributorTable.tsx`** and **`components/RepoActivityTable.tsx`** — presentational tables mirroring `ReconciliationTable`.
- **Replace `app/(dashboard)/dev-reporting/page.tsx`** — stateful client page (date range → fetch → `useMemo(summarize)` → tables).
- **Create `scripts/dev-report.ts`** — CLI consuming `githubClient` + `devStats`.
- **Modify `app/(dashboard)/layout.tsx:10`** — flip Dev Reporting `enabled` to `true`.
- **Modify `package.json`** — add `tsx` devDependency + `dev-report` script.
- **Modify `.env.example`** — document `GH_ACCESS_TOKEN`.

---

### Task 1: Shared GraphQL client (`lib/githubClient.ts`)

**Files:**
- Create: `lib/githubClient.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write the client module**

Create `lib/githubClient.ts` with this exact content:

```ts
/**
 * Shared GitHub GraphQL client for dev reporting. NOT server-only: it reads no
 * environment and is imported by both the API-route wrapper (lib/github.ts) and
 * the CLI (scripts/dev-report.ts). The access token is always INJECTED by the
 * caller and never read here.
 *
 * Why no `import "server-only"` here: that package's default export throws in a
 * plain Node process (only Next's `react-server` condition no-ops it), which
 * would break the CLI. The browser-token tripwire lives in lib/github.ts.
 *
 * Source: GitHub GraphQL API v4. Per active repo we walk the default branch
 * commit history (commits carry additions/deletions + author login at day
 * precision) and the pull requests (ordered by updatedAt desc so we can stop
 * paging once a page predates the period). All fetches use cache: "no-store".
 */

const GITHUB_GRAPHQL = "https://api.github.com/graphql";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface RepoRecord {
  name: string;
  isArchived: boolean;
  isFork: boolean;
  /** Default branch name, or null for an empty repo. */
  defaultBranch: string | null;
}

export interface CommitRecord {
  repo: string;
  oid: string;
  /** ISO 8601 commit timestamp. */
  committedDate: string;
  additions: number;
  deletions: number;
  /** GitHub login when the commit author is linked to an account, else null. */
  authorLogin: string | null;
  /** Display fallback (commit author name) used when authorLogin is null. */
  authorName: string;
  isBot: boolean;
}

export interface PullRequestRecord {
  repo: string;
  number: number;
  authorLogin: string | null;
  authorName: string;
  isBot: boolean;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601, or null when not merged. */
  mergedAt: string | null;
  additions: number;
  deletions: number;
}

export interface OrgActivity {
  org: string;
  /** Inclusive period bounds, YYYY-MM-DD. */
  start: string;
  end: string;
  /** Active repos included (archived + forks already filtered out). */
  repos: RepoRecord[];
  /** Commits on each repo's default branch within [start, end] (UTC). */
  commits: CommitRecord[];
  /** PRs scanned for the period (superset; devStats buckets opened/merged). */
  pullRequests: PullRequestRecord[];
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface FetchOrgActivityOptions {
  token: string;
  org: string;
  start: string;
  end: string;
}

function actorIsBot(typename: string | undefined, login: string | null): boolean {
  return typename === "Bot" || (!!login && login.endsWith("[bot]"));
}

async function graphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(GITHUB_GRAPHQL, {
      method: "POST",
      headers: {
        Authorization: `bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "orients-ops-console",
      },
      body: JSON.stringify({ query, variables }),
      // Reporting must reflect live truth.
      cache: "no-store",
    });
  } catch (e) {
    throw new GitHubError(
      `GitHub request failed: ${e instanceof Error ? e.message : String(e)}`,
      502,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GitHubError(
      `GitHub API returned ${res.status} ${res.statusText}${
        body ? `: ${body.slice(0, 300)}` : ""
      }`,
      res.status,
    );
  }

  const json = (await res.json()) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (json.errors?.length) {
    throw new GitHubError(
      `GitHub GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`,
      502,
    );
  }
  if (!json.data) {
    throw new GitHubError("GitHub GraphQL response had no data.", 502);
  }
  return json.data;
}

interface RepoPage {
  organization: {
    repositories: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: {
        name: string;
        isArchived: boolean;
        isFork: boolean;
        defaultBranchRef: { name: string } | null;
      }[];
    };
  } | null;
}

const REPOS_QUERY = `
query($org: String!, $cursor: String) {
  organization(login: $org) {
    repositories(first: 100, after: $cursor, orderBy: {field: PUSHED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { name isArchived isFork defaultBranchRef { name } }
    }
  }
}`;

async function fetchRepos(token: string, org: string): Promise<RepoRecord[]> {
  const repos: RepoRecord[] = [];
  let cursor: string | null = null;
  do {
    const data: RepoPage = await graphql<RepoPage>(token, REPOS_QUERY, {
      org,
      cursor,
    });
    if (!data.organization) {
      throw new GitHubError(
        `Organization not found or inaccessible: ${org}`,
        404,
      );
    }
    const conn = data.organization.repositories;
    for (const n of conn.nodes) {
      repos.push({
        name: n.name,
        isArchived: n.isArchived,
        isFork: n.isFork,
        defaultBranch: n.defaultBranchRef?.name ?? null,
      });
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return repos;
}

interface CommitPage {
  repository: {
    defaultBranchRef: {
      target: {
        history?: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: {
            oid: string;
            committedDate: string;
            additions: number;
            deletions: number;
            author: {
              name: string | null;
              user: { login: string; __typename: string } | null;
            } | null;
          }[];
        };
      } | null;
    } | null;
  } | null;
}

const COMMITS_QUERY = `
query($org: String!, $repo: String!, $since: GitTimestamp!, $until: GitTimestamp!, $cursor: String) {
  repository(owner: $org, name: $repo) {
    defaultBranchRef {
      target {
        ... on Commit {
          history(since: $since, until: $until, first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              oid
              committedDate
              additions
              deletions
              author { name user { login __typename } }
            }
          }
        }
      }
    }
  }
}`;

async function fetchCommits(
  token: string,
  org: string,
  repo: string,
  since: string,
  until: string,
): Promise<CommitRecord[]> {
  const out: CommitRecord[] = [];
  let cursor: string | null = null;
  do {
    const data: CommitPage = await graphql<CommitPage>(token, COMMITS_QUERY, {
      org,
      repo,
      since,
      until,
      cursor,
    });
    const history = data.repository?.defaultBranchRef?.target?.history;
    if (!history) break; // empty repo / target is not a Commit
    for (const n of history.nodes) {
      const login = n.author?.user?.login ?? null;
      out.push({
        repo,
        oid: n.oid,
        committedDate: n.committedDate,
        additions: n.additions,
        deletions: n.deletions,
        authorLogin: login,
        authorName: n.author?.name ?? login ?? "(unknown)",
        isBot: actorIsBot(n.author?.user?.__typename, login),
      });
    }
    cursor = history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

interface PrPage {
  repository: {
    pullRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: {
        number: number;
        createdAt: string;
        mergedAt: string | null;
        updatedAt: string;
        additions: number;
        deletions: number;
        author: { login: string; __typename: string } | null;
      }[];
    };
  } | null;
}

const PRS_QUERY = `
query($org: String!, $repo: String!, $cursor: String) {
  repository(owner: $org, name: $repo) {
    pullRequests(first: 100, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number createdAt mergedAt updatedAt additions deletions
        author { login __typename }
      }
    }
  }
}`;

async function fetchPullRequests(
  token: string,
  org: string,
  repo: string,
  sinceMs: number,
): Promise<PullRequestRecord[]> {
  const out: PullRequestRecord[] = [];
  let cursor: string | null = null;
  do {
    const data: PrPage = await graphql<PrPage>(token, PRS_QUERY, {
      org,
      repo,
      cursor,
    });
    const conn = data.repository?.pullRequests;
    if (!conn) break;
    let reachedOld = false;
    for (const n of conn.nodes) {
      // Ordered by updatedAt desc. Any PR that is opened OR merged in-period has
      // updatedAt >= period start, so once updatedAt predates the start, neither
      // this PR nor anything after it can contribute — stop paging.
      if (Date.parse(n.updatedAt) < sinceMs) {
        reachedOld = true;
        break;
      }
      const login = n.author?.login ?? null;
      out.push({
        repo,
        number: n.number,
        authorLogin: login,
        authorName: login ?? "(unknown)",
        isBot: actorIsBot(n.author?.__typename, login),
        createdAt: n.createdAt,
        mergedAt: n.mergedAt,
        additions: n.additions,
        deletions: n.deletions,
      });
    }
    if (reachedOld) break;
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

/**
 * Fetch commits-on-default-branch + pull requests for every active repo
 * (non-archived, non-fork) in `org`, scoped to the [start, end] UTC day window.
 * Sequential per repo to stay clear of GitHub's secondary rate limits.
 */
export async function fetchOrgActivity(
  opts: FetchOrgActivityOptions,
): Promise<OrgActivity> {
  const { token, org, start, end } = opts;
  if (!token) throw new GitHubError("GitHub access token is missing.");
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new GitHubError(
      `Period bounds must be YYYY-MM-DD: start=${start} end=${end}`,
    );
  }
  if (start > end) {
    throw new GitHubError("`start` must be on or before `end`.");
  }

  const since = `${start}T00:00:00.000Z`;
  const until = `${end}T23:59:59.999Z`;
  const sinceMs = Date.parse(since);

  const allRepos = await fetchRepos(token, org);
  const active = allRepos.filter((r) => !r.isArchived && !r.isFork);

  const commits: CommitRecord[] = [];
  const pullRequests: PullRequestRecord[] = [];

  for (const repo of active) {
    if (repo.defaultBranch) {
      commits.push(...(await fetchCommits(token, org, repo.name, since, until)));
    }
    pullRequests.push(
      ...(await fetchPullRequests(token, org, repo.name, sinceMs)),
    );
  }

  return { org, start, end, repos: active, commits, pullRequests };
}
```

- [ ] **Step 2: Document the env var**

Append to `.env.example`:

```
# GitHub personal access token (server-side only) for Dev Reporting.
# Scopes: `repo` (read) to include private repos + `read:org`.
# Read only in lib/github.ts (web) and scripts/dev-report.ts (CLI); never sent
# to the browser. Without it, GET /api/github returns 500 and the CLI exits 1.
GH_ACCESS_TOKEN=
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/githubClient.ts .env.example
git commit -m "Add shared GitHub GraphQL client for dev reporting

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Pure aggregation (`lib/devStats.ts`) — TDD

**Files:**
- Test: `lib/devStats.test.ts`
- Create: `lib/devStats.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/devStats.test.ts` with this exact content:

```ts
import { describe, expect, it } from "vitest";
import {
  buildContributorLeaderboard,
  buildRepoRanking,
  summarize,
} from "./devStats";
import type {
  CommitRecord,
  OrgActivity,
  PullRequestRecord,
  RepoRecord,
} from "./githubClient";

function repo(name: string): RepoRecord {
  return { name, isArchived: false, isFork: false, defaultBranch: "main" };
}

function commit(
  repoName: string,
  login: string | null,
  additions: number,
  deletions: number,
  opts: { name?: string; isBot?: boolean; date?: string } = {},
): CommitRecord {
  return {
    repo: repoName,
    oid: `${repoName}-${login}-${additions}-${deletions}-${opts.date ?? "x"}`,
    committedDate: opts.date ?? "2026-05-10T12:00:00Z",
    additions,
    deletions,
    authorLogin: login,
    authorName: opts.name ?? login ?? "(unknown)",
    isBot: opts.isBot ?? false,
  };
}

function pr(
  repoName: string,
  login: string,
  opts: {
    number?: number;
    createdAt?: string;
    mergedAt?: string | null;
    isBot?: boolean;
  } = {},
): PullRequestRecord {
  return {
    repo: repoName,
    number: opts.number ?? 1,
    authorLogin: login,
    authorName: login,
    isBot: opts.isBot ?? false,
    createdAt: opts.createdAt ?? "2026-05-10T12:00:00Z",
    mergedAt: opts.mergedAt ?? null,
    additions: 0,
    deletions: 0,
  };
}

function activity(partial: Partial<OrgActivity>): OrgActivity {
  return {
    org: "orients-ai",
    start: "2026-05-01",
    end: "2026-05-31",
    repos: partial.repos ?? [],
    commits: partial.commits ?? [],
    pullRequests: partial.pullRequests ?? [],
  };
}

describe("buildContributorLeaderboard", () => {
  it("sums commits, additions, deletions and net per user", () => {
    const rows = buildContributorLeaderboard(
      activity({
        repos: [repo("api")],
        commits: [
          commit("api", "alice", 100, 40),
          commit("api", "alice", 20, 5),
          commit("api", "bob", 10, 0),
        ],
      }),
    );
    const alice = rows.find((r) => r.login === "alice")!;
    expect(alice.commits).toBe(2);
    expect(alice.additions).toBe(120);
    expect(alice.deletions).toBe(45);
    expect(alice.net).toBe(75);
    // alice has more commits than bob, so she ranks first.
    expect(rows[0].login).toBe("alice");
  });

  it("counts PRs opened and merged in independent windows", () => {
    const rows = buildContributorLeaderboard(
      activity({
        pullRequests: [
          // opened in period, not merged
          pr("api", "alice", { number: 1, createdAt: "2026-05-03T10:00:00Z" }),
          // opened BEFORE period, merged IN period
          pr("api", "alice", {
            number: 2,
            createdAt: "2026-04-20T10:00:00Z",
            mergedAt: "2026-05-04T10:00:00Z",
          }),
          // opened in period, merged AFTER period
          pr("api", "alice", {
            number: 3,
            createdAt: "2026-05-29T10:00:00Z",
            mergedAt: "2026-06-02T10:00:00Z",
          }),
        ],
      }),
    );
    const alice = rows.find((r) => r.login === "alice")!;
    expect(alice.prsOpened).toBe(2); // #1 and #3
    expect(alice.prsMerged).toBe(1); // #2
  });

  it("falls back to author name and flags unlinked commits", () => {
    const rows = buildContributorLeaderboard(
      activity({ commits: [commit("api", null, 5, 1, { name: "No Account" })] }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].login).toBeNull();
    expect(rows[0].displayName).toBe("No Account");
    expect(rows[0].unlinked).toBe(true);
  });

  it("flags bots and sorts them after humans regardless of commit count", () => {
    const rows = buildContributorLeaderboard(
      activity({
        commits: [
          commit("api", "dependabot[bot]", 999, 999, { isBot: true }),
          commit("api", "alice", 1, 0),
        ],
      }),
    );
    expect(rows[0].login).toBe("alice");
    expect(rows[1].login).toBe("dependabot[bot]");
    expect(rows[1].isBot).toBe(true);
  });
});

describe("buildRepoRanking", () => {
  it("ranks by composite activity (commits + prsOpened + prsMerged) and seeds zero-activity repos", () => {
    const rows = buildRepoRanking(
      activity({
        repos: [repo("api"), repo("web"), repo("idle")],
        commits: [commit("web", "alice", 1, 1), commit("api", "alice", 1, 1)],
        pullRequests: [
          pr("api", "alice", { createdAt: "2026-05-03T10:00:00Z" }),
          pr("api", "bob", {
            number: 2,
            createdAt: "2026-05-03T10:00:00Z",
            mergedAt: "2026-05-04T10:00:00Z",
          }),
        ],
      }),
    );
    expect(rows.map((r) => r.repo)).toEqual(["api", "web", "idle"]);
    expect(rows[0].activityScore).toBe(3); // 1 commit + 1 opened + 1 merged
    expect(rows[2].activityScore).toBe(0); // idle repo still listed
  });
});

describe("summarize", () => {
  it("rolls up totals and counts only human contributors", () => {
    const summary = summarize(
      activity({
        repos: [repo("api")],
        commits: [
          commit("api", "alice", 10, 2),
          commit("api", "dependabot[bot]", 3, 0, { isBot: true }),
        ],
        pullRequests: [
          pr("api", "alice", {
            createdAt: "2026-05-03T10:00:00Z",
            mergedAt: "2026-05-05T10:00:00Z",
          }),
        ],
      }),
    );
    expect(summary.totals.repos).toBe(1);
    expect(summary.totals.contributors).toBe(1); // alice only; bot excluded
    expect(summary.totals.commits).toBe(2);
    expect(summary.totals.additions).toBe(13);
    expect(summary.totals.prsOpened).toBe(1);
    expect(summary.totals.prsMerged).toBe(1);
    expect(summary.period).toEqual({ start: "2026-05-01", end: "2026-05-31" });
  });

  it("handles empty activity", () => {
    const summary = summarize(activity({}));
    expect(summary.contributors).toEqual([]);
    expect(summary.repos).toEqual([]);
    expect(summary.totals.commits).toBe(0);
    expect(summary.totals.contributors).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/devStats.test.ts`
Expected: FAIL — cannot import from `./devStats` (module does not exist).

- [ ] **Step 3: Write the implementation**

Create `lib/devStats.ts` with this exact content:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/devStats.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add lib/devStats.ts lib/devStats.test.ts
git commit -m "Add pure dev-stats aggregation with unit tests

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Server-only wrapper (`lib/github.ts`)

**Files:**
- Create: `lib/github.ts`

- [ ] **Step 1: Write the wrapper**

Create `lib/github.ts` with this exact content:

```ts
/**
 * Server-only entry point for dev reporting. SERVER-ONLY.
 *
 * Reads GH_ACCESS_TOKEN from process.env and delegates to the shared
 * lib/githubClient. The `server-only` import makes an accidental client import
 * a build error — the token must never reach the browser. The CLI does NOT use
 * this module; it calls lib/githubClient directly (server-only throws in plain
 * Node).
 */
import "server-only";
import {
  fetchOrgActivity,
  GitHubError,
  type OrgActivity,
} from "./githubClient";

/** The org all dev reporting covers (github.com/orients-ai). */
export const ORG = "orients-ai";

function token(): string {
  const value = process.env.GH_ACCESS_TOKEN;
  if (!value) {
    throw new GitHubError("GH_ACCESS_TOKEN is not set on the server.");
  }
  return value;
}

/** Fetch org activity for the period using the server-side token. */
export function fetchOrgActivityForPeriod(
  start: string,
  end: string,
): Promise<OrgActivity> {
  return fetchOrgActivity({ token: token(), org: ORG, start, end });
}

export { GitHubError };
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/github.ts
git commit -m "Add server-only GitHub wrapper reading GH_ACCESS_TOKEN

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: API route (`app/api/github/route.ts`)

**Files:**
- Create: `app/api/github/route.ts`

- [ ] **Step 1: Write the route**

Create `app/api/github/route.ts` with this exact content:

```ts
import { NextResponse } from "next/server";
import { fetchOrgActivityForPeriod, GitHubError } from "@/lib/github";

// Token + GitHub calls live only on the server; never statically cache.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/github?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * The browser calls this route (never GitHub directly). We fetch the period's
 * org activity server-side using GH_ACCESS_TOKEN and return it as JSON.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const start = searchParams.get("start");
  const end = searchParams.get("end");

  if (!start || !end) {
    return NextResponse.json(
      { error: "Both `start` and `end` query params are required." },
      { status: 400 },
    );
  }
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    return NextResponse.json(
      { error: "`start` and `end` must be YYYY-MM-DD dates." },
      { status: 400 },
    );
  }
  if (start > end) {
    return NextResponse.json(
      { error: "`start` must be on or before `end`." },
      { status: 400 },
    );
  }

  try {
    const activity = await fetchOrgActivityForPeriod(start, end);
    return NextResponse.json({ activity });
  } catch (error) {
    if (error instanceof GitHubError) {
      // Missing token / upstream failures: 502 for upstream, 500 for config.
      const status = error.status ? 502 : 500;
      return NextResponse.json({ error: error.message }, { status });
    }
    const message =
      error instanceof Error ? error.message : "Unexpected server error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/github/route.ts
git commit -m "Add GET /api/github dev-reporting route

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Table components

**Files:**
- Create: `components/ContributorTable.tsx`
- Create: `components/RepoActivityTable.tsx`

- [ ] **Step 1: Write the contributor table**

Create `components/ContributorTable.tsx` with this exact content:

```tsx
import type { ContributorRow } from "@/lib/devStats";

/** Signed integer for the net column (e.g. +120, -8, 0). */
function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/** Contributor leaderboard — bot rows are tinted and badged. */
export function ContributorTable({ rows }: { rows: ContributorRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
        Pick a period and load activity to see contributors.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <th className="px-3 py-2">Contributor</th>
            <th className="px-3 py-2 text-right">Commits</th>
            <th className="px-3 py-2 text-right">+ Added</th>
            <th className="px-3 py-2 text-right">&minus; Deleted</th>
            <th className="px-3 py-2 text-right">Net</th>
            <th className="px-3 py-2 text-right">PRs opened</th>
            <th className="px-3 py-2 text-right">PRs merged</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.key}
              className={`border-b border-slate-100 last:border-0 ${
                row.isBot ? "bg-slate-50" : "hover:bg-slate-50"
              }`}
            >
              <td className="px-3 py-2 font-medium text-slate-900">
                {row.displayName}
                {row.isBot && (
                  <span className="ml-2 inline-flex rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600">
                    bot
                  </span>
                )}
                {row.unlinked && !row.isBot && (
                  <span className="ml-2 inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                    unlinked
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                {row.commits}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-emerald-700">
                {row.additions}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-rose-700">
                {row.deletions}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                {signed(row.net)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                {row.prsOpened}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                {row.prsMerged}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Write the repo activity table**

Create `components/RepoActivityTable.tsx` with this exact content:

```tsx
import type { RepoRow } from "@/lib/devStats";

/** Most-active-repositories ranking, ordered by composite activity score. */
export function RepoActivityTable({ rows }: { rows: RepoRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
        Pick a period and load activity to see repository activity.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <th className="px-3 py-2">Repository</th>
            <th className="px-3 py-2 text-right">Commits</th>
            <th className="px-3 py-2 text-right">+ Added</th>
            <th className="px-3 py-2 text-right">&minus; Deleted</th>
            <th className="px-3 py-2 text-right">PRs opened</th>
            <th className="px-3 py-2 text-right">PRs merged</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.repo}
              className="border-b border-slate-100 last:border-0 hover:bg-slate-50"
            >
              <td className="px-3 py-2 font-medium text-slate-900">
                {row.repo}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                {row.commits}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-emerald-700">
                {row.additions}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-rose-700">
                {row.deletions}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                {row.prsOpened}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                {row.prsMerged}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add components/ContributorTable.tsx components/RepoActivityTable.tsx
git commit -m "Add contributor + repo activity tables

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Dashboard page + enable the tab

**Files:**
- Replace: `app/(dashboard)/dev-reporting/page.tsx`
- Modify: `app/(dashboard)/layout.tsx:10`

- [ ] **Step 1: Write the page**

Replace the entire contents of `app/(dashboard)/dev-reporting/page.tsx` with:

```tsx
"use client";

import { useMemo, useState } from "react";
import type { OrgActivity } from "@/lib/githubClient";
import { summarize } from "@/lib/devStats";
import { ContributorTable } from "@/components/ContributorTable";
import { RepoActivityTable } from "@/components/RepoActivityTable";

/** `YYYY-MM-DD` for `days` ago in UTC. */
function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function DevReportingPage() {
  const [start, setStart] = useState(() => isoDaysAgo(30));
  const [end, setEnd] = useState(todayIso);
  const [activity, setActivity] = useState<OrgActivity | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const summary = useMemo(
    () => (activity ? summarize(activity) : null),
    [activity],
  );

  async function loadActivity() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ start, end });
      const res = await fetch(`/api/github?${params.toString()}`);
      const body = await res.json();
      if (!res.ok)
        throw new Error(body.error ?? `Request failed (${res.status})`);
      setActivity(body.activity as OrgActivity);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load activity.");
      setActivity(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">
          Dev Reporting — GitHub Activity
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Commits, pull requests and code landed on the default branch across
          active <strong>orients-ai</strong> repositories. Day boundaries are
          UTC. Bot accounts are flagged and ranked after humans.
        </p>
      </div>

      {/* Controls */}
      <div className="rounded-md border border-slate-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-900">Period</h3>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Start
            <input
              type="date"
              value={start}
              max={end}
              onChange={(e) => setStart(e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1 text-sm tabular-nums"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            End
            <input
              type="date"
              value={end}
              min={start}
              onChange={(e) => setEnd(e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1 text-sm tabular-nums"
            />
          </label>
          <button
            type="button"
            onClick={loadActivity}
            disabled={loading || !start || !end}
            className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Loading…" : "Load activity"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Period summary */}
      {summary && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryCard label="Active repos" value={String(summary.totals.repos)} />
          <SummaryCard
            label="Contributors"
            value={String(summary.totals.contributors)}
          />
          <SummaryCard label="Commits" value={String(summary.totals.commits)} />
          <SummaryCard
            label="PRs merged"
            value={String(summary.totals.prsMerged)}
          />
        </div>
      )}

      {/* Contributors */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-900">Contributors</h2>
        {summary === null ? (
          <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
            Pick a period and load activity to begin.
          </p>
        ) : (
          <ContributorTable rows={summary.contributors} />
        )}
      </section>

      {/* Repositories */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-900">
          Most active repositories
        </h2>
        {summary === null ? (
          <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
            Pick a period and load activity to begin.
          </p>
        ) : (
          <RepoActivityTable rows={summary.repos} />
        )}
      </section>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
        {value}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Enable the Dev Reporting tab**

In `app/(dashboard)/layout.tsx`, change line 10 from:

```tsx
  { href: "/dev-reporting", label: "Dev Reporting", enabled: false },
```

to:

```tsx
  { href: "/dev-reporting", label: "Dev Reporting", enabled: true },
```

- [ ] **Step 3: Build to verify the page + server/client boundary compile**

Run: `npm run build`
Expected: build succeeds; `/dev-reporting` and `/api/github` appear in the route output, with no "server-only imported from client" error.

- [ ] **Step 4: Commit**

```bash
git add "app/(dashboard)/dev-reporting/page.tsx" "app/(dashboard)/layout.tsx"
git commit -m "Add Dev Reporting dashboard page and enable the tab

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: CLI (`scripts/dev-report.ts`)

**Files:**
- Create: `scripts/dev-report.ts`
- Modify: `package.json`

- [ ] **Step 1: Add the `tsx` runner**

Run: `npm install --save-dev tsx`
Expected: `tsx` added to `devDependencies`; `package-lock.json` updated.

- [ ] **Step 2: Add the npm script**

In `package.json`, add this entry to the `"scripts"` object (after `"test:watch"`):

```json
    "dev-report": "node --env-file=.env --import tsx scripts/dev-report.ts"
```

(Remember to add a comma after the preceding `"test:watch"` line.)

- [ ] **Step 3: Write the CLI**

Create `scripts/dev-report.ts` with this exact content:

```ts
/**
 * CLI for GitHub dev reporting. Shares the web path's code: fetches org
 * activity via lib/githubClient and aggregates via lib/devStats.
 *
 * Usage:
 *   npm run dev-report -- --start=2026-05-01 --end=2026-05-31
 *   npm run dev-report -- --json
 * Defaults to the last 30 days when --start / --end are omitted. Run via
 * `node --env-file=.env --import tsx` so GH_ACCESS_TOKEN is loaded from .env.
 */
import { fetchOrgActivity } from "../lib/githubClient";
import {
  summarize,
  type ContributorRow,
  type RepoRow,
} from "../lib/devStats";

const ORG = "orients-ai";

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

interface CliArgs {
  start: string;
  end: string;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let start = isoDaysAgo(30);
  let end = todayIso();
  let json = false;
  for (const arg of argv) {
    if (arg === "--json") json = true;
    else if (arg.startsWith("--start=")) start = arg.slice("--start=".length);
    else if (arg.startsWith("--end=")) end = arg.slice("--end=".length);
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return { start, end, json };
}

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function padLeft(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

function printContributors(rows: ContributorRow[]): void {
  console.log("\nContributors");
  console.log(
    padRight("USER", 26) +
      padLeft("COMMITS", 9) +
      padLeft("+ADD", 9) +
      padLeft("-DEL", 9) +
      padLeft("NET", 9) +
      padLeft("PR_OPEN", 9) +
      padLeft("PR_MRG", 9),
  );
  for (const r of rows) {
    const tag = r.isBot ? " [bot]" : r.unlinked ? " (unlinked)" : "";
    console.log(
      padRight((r.displayName + tag).slice(0, 25), 26) +
        padLeft(String(r.commits), 9) +
        padLeft(String(r.additions), 9) +
        padLeft(String(r.deletions), 9) +
        padLeft(signed(r.net), 9) +
        padLeft(String(r.prsOpened), 9) +
        padLeft(String(r.prsMerged), 9),
    );
  }
}

function printRepos(rows: RepoRow[]): void {
  console.log("\nMost active repositories");
  console.log(
    padRight("REPO", 30) +
      padLeft("COMMITS", 9) +
      padLeft("+ADD", 9) +
      padLeft("-DEL", 9) +
      padLeft("PR_OPEN", 9) +
      padLeft("PR_MRG", 9),
  );
  for (const r of rows) {
    console.log(
      padRight(r.repo.slice(0, 29), 30) +
        padLeft(String(r.commits), 9) +
        padLeft(String(r.additions), 9) +
        padLeft(String(r.deletions), 9) +
        padLeft(String(r.prsOpened), 9) +
        padLeft(String(r.prsMerged), 9),
    );
  }
}

async function main(): Promise<void> {
  const token = process.env.GH_ACCESS_TOKEN;
  if (!token) {
    console.error("GH_ACCESS_TOKEN is not set. Add it to .env.");
    process.exit(1);
  }

  const { start, end, json } = parseArgs(process.argv.slice(2));
  const activity = await fetchOrgActivity({ token, org: ORG, start, end });
  const summary = summarize(activity);

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`Dev report for ${summary.org}   ${start} .. ${end}`);
  console.log(
    `Repos: ${summary.totals.repos}   ` +
      `Contributors: ${summary.totals.contributors}   ` +
      `Commits: ${summary.totals.commits}   ` +
      `Net lines: ${summary.totals.net}   ` +
      `PRs opened: ${summary.totals.prsOpened}   ` +
      `PRs merged: ${summary.totals.prsMerged}`,
  );
  printContributors(summary.contributors);
  printRepos(summary.repos);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
```

- [ ] **Step 4: Run the CLI against the real org (token is in `.env`)**

Run: `npm run dev-report -- --start=2026-06-01 --end=2026-06-15`
Expected: prints the `Dev report for orients-ai …` header line, totals, the Contributors table, and the Most active repositories table — no errors. (If the token lacks `repo`/`read:org` scope it will error clearly; fix the token and re-run.)

- [ ] **Step 5: Verify the JSON mode**

Run: `npm run dev-report -- --start=2026-06-01 --end=2026-06-15 --json`
Expected: a single JSON object with `org`, `period`, `contributors`, `repos`, `totals`.

- [ ] **Step 6: Commit**

```bash
git add scripts/dev-report.ts package.json package-lock.json
git commit -m "Add dev-report CLI over shared dev-reporting logic

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Run `npm test` — Vitest suite (including `devStats.test.ts`) passes.
- [ ] Run `npm run lint` — no lint errors.
- [ ] Run `npm run build` — production build succeeds with `/dev-reporting` + `/api/github` present.
- [ ] Manual web check: `npm run dev`, open `/dev-reporting`, load a period, confirm contributor + repo tables render and bots are badged.
- [ ] Manual CLI check: `npm run dev-report -- --start=… --end=…` prints matching numbers.

---

## Self-Review notes

- **Spec coverage:** repo scope (active = non-archived, non-fork) → `fetchOrgActivity` filter; PRs opened+merged separately → `inPeriod` on `createdAt`/`mergedAt`; all code-volume measures (additions/deletions/net/commits) → row types + tables; user leaderboard + repo ranking → `buildContributorLeaderboard`/`buildRepoRanking`; bots shown+flagged → `isBot` handling + badge; single request + loading state → page `loadActivity`; CLI + web over shared `lib/` → Tasks 6 & 7 both consume `devStats`; token never in browser → `server-only` wrapper (Task 3); env documented → Task 1 Step 2.
- **Type consistency:** `OrgActivity`/`CommitRecord`/`PullRequestRecord`/`RepoRecord` defined in Task 1 and imported as types everywhere; `ContributorRow`/`RepoRow`/`DevStatsSummary` defined in Task 2 and consumed by Tasks 5–7; `fetchOrgActivity` (client) vs `fetchOrgActivityForPeriod` (wrapper) names used consistently.
- **No placeholders:** every code step contains complete content.
