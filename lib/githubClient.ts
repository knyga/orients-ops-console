/**
 * Shared GitHub GraphQL client for dev reporting. NOT server-only: it reads no
 * environment and is imported by both the API-route wrapper (lib/github.ts) and
 * the CLI (scripts/github.ts). The access token is always INJECTED by the
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
  /** First line of the commit message (feeds the occupation summary). */
  messageHeadline: string;
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
  /** PR title (feeds the occupation summary). */
  title: string;
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
            messageHeadline: string;
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
              messageHeadline
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
        messageHeadline: n.messageHeadline,
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
        title: string;
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
        number title createdAt mergedAt updatedAt additions deletions
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
        title: n.title,
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
