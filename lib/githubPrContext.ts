/**
 * Fetch layer for the investor report's git grounding: the week's merged PRs
 * across every active org repo, with description, comments and unified diff.
 * NOT server-only (token always injected by the caller) — same convention and
 * reasons as lib/githubClient.ts, whose graphql/fetchRepos/actorIsBot it
 * reuses. All selection/shaping logic is pure and lives in lib/prGrounding.ts;
 * this module only talks to the network.
 *
 * Diff text comes from the REST diff media type (GraphQL has no diff text).
 * A raw diff is clamped to a hard safety cap here (never hold megabytes);
 * the real prompt cap + «…[обрізано]» marker is buildPrGroundingText's job.
 */
import { actorIsBot, fetchRepos, graphql, GitHubError } from "./githubClient";
import { selectMergedInWindow, type PrContext } from "./prGrounding";

/** Above the prompt cap (15k) so the builder still flags truncation. */
const RAW_DIFF_SAFETY_CAP = 200_000;

interface PrContextPage {
  repository: {
    pullRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: {
        number: number;
        title: string;
        body: string;
        mergedAt: string | null;
        updatedAt: string;
        author: { login: string; __typename: string } | null;
        comments: {
          nodes: { author: { login: string; __typename: string } | null; body: string }[];
        };
        reviews: {
          nodes: { author: { login: string; __typename: string } | null; body: string }[];
        };
      }[];
    };
  } | null;
}

const PR_CONTEXT_QUERY = `
query($org: String!, $repo: String!, $cursor: String) {
  repository(owner: $org, name: $repo) {
    pullRequests(first: 50, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title body mergedAt updatedAt
        author { login __typename }
        comments(first: 15) { nodes { author { login __typename } body } }
        reviews(first: 15) { nodes { author { login __typename } body } }
      }
    }
  }
}`;

type PrCandidate = Omit<PrContext, "diff"> & { repo: string };

async function fetchMergedPrCandidates(
  token: string,
  org: string,
  repo: string,
  sinceMs: number,
): Promise<PrCandidate[]> {
  const out: PrCandidate[] = [];
  let cursor: string | null = null;
  do {
    const data: PrContextPage = await graphql<PrContextPage>(token, PR_CONTEXT_QUERY, {
      org,
      repo,
      cursor,
    });
    const conn = data.repository?.pullRequests;
    if (!conn) break;
    let reachedOld = false;
    for (const n of conn.nodes) {
      // Ordered by updatedAt desc; a PR merged in-period has updatedAt >= start.
      if (Date.parse(n.updatedAt) < sinceMs) {
        reachedOld = true;
        break;
      }
      const login = n.author?.login ?? null;
      if (!n.mergedAt || actorIsBot(n.author?.__typename, login)) continue;
      // Issue comments + non-empty review bodies, human authors only.
      const comments = [...n.comments.nodes, ...n.reviews.nodes]
        .filter((c) => c.body.trim() && !actorIsBot(c.author?.__typename, c.author?.login ?? null))
        .map((c) => ({ author: c.author?.login ?? "(unknown)", body: c.body.trim() }));
      out.push({
        repo,
        number: n.number,
        title: n.title,
        author: login ?? "(unknown)",
        body: n.body.trim(),
        mergedAt: n.mergedAt,
        comments,
      });
    }
    if (reachedOld) break;
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

async function fetchPrDiff(
  token: string,
  org: string,
  repo: string,
  number: number,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${org}/${repo}/pulls/${number}`, {
      headers: {
        Authorization: `bearer ${token}`,
        Accept: "application/vnd.github.diff",
        "User-Agent": "orients-ops-console",
      },
      cache: "no-store",
    });
  } catch (e) {
    throw new GitHubError(
      `GitHub diff request failed for ${repo}#${number}: ${e instanceof Error ? e.message : String(e)}`,
      502,
    );
  }
  if (!res.ok) {
    throw new GitHubError(
      `GitHub diff for ${repo}#${number} returned ${res.status} ${res.statusText}`,
      res.status,
    );
  }
  const text = await res.text();
  return text.length > RAW_DIFF_SAFETY_CAP ? text.slice(0, RAW_DIFF_SAFETY_CAP) : text;
}

export interface FetchMergedPrContextsOptions {
  token: string;
  org: string;
  /** Inclusive UTC day window, YYYY-MM-DD. */
  start: string;
  end: string;
  maxPrs: number;
}

/**
 * The week's human-authored merged PRs across all active (non-archived,
 * non-fork) org repos, newest merge first, capped at maxPrs, each with its
 * description, human comments and unified diff. Sequential per repo/PR to
 * stay clear of GitHub's secondary rate limits (same as fetchOrgActivity).
 */
export async function fetchMergedPrContexts(
  opts: FetchMergedPrContextsOptions,
): Promise<PrContext[]> {
  const { token, org, start, end, maxPrs } = opts;
  if (!token) throw new GitHubError("GitHub access token is missing.");
  const sinceMs = Date.parse(`${start}T00:00:00.000Z`);

  const repos = (await fetchRepos(token, org)).filter((r) => !r.isArchived && !r.isFork);
  const candidates: PrCandidate[] = [];
  for (const repo of repos) {
    candidates.push(...(await fetchMergedPrCandidates(token, org, repo.name, sinceMs)));
  }

  const selected = selectMergedInWindow(candidates, start, end, maxPrs);
  const out: PrContext[] = [];
  for (const pr of selected) {
    out.push({ ...pr, diff: await fetchPrDiff(token, org, pr.repo, pr.number) });
  }
  return out;
}
