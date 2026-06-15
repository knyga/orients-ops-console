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
