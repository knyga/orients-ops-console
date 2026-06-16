import { describe, expect, it } from "vitest";
import {
  buildContributorLeaderboard,
  buildRepoRanking,
  summarize,
  workByContributor,
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
  opts: { name?: string; isBot?: boolean; date?: string; message?: string } = {},
): CommitRecord {
  return {
    repo: repoName,
    oid: `${repoName}-${login}-${additions}-${deletions}-${opts.date ?? "x"}`,
    messageHeadline: opts.message ?? "commit headline",
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
    title?: string;
  } = {},
): PullRequestRecord {
  return {
    repo: repoName,
    number: opts.number ?? 1,
    title: opts.title ?? "pr title",
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

  it("sums commits as-is without re-filtering by date (they are pre-windowed by the fetch)", () => {
    // Commit dated well outside the [2026-05-01, 2026-05-31] period. devStats
    // trusts the client to have windowed commits, so it is still counted.
    const rows = buildContributorLeaderboard(
      activity({
        commits: [commit("api", "alice", 7, 2, { date: "2026-01-01T12:00:00Z" })],
      }),
    );
    const alice = rows.find((r) => r.login === "alice")!;
    expect(alice.commits).toBe(1);
    expect(alice.additions).toBe(7);
  });

  it("marks a contributor as a bot when any of their records is a bot", () => {
    const rows = buildContributorLeaderboard(
      activity({
        commits: [
          commit("api", "ci-acct", 1, 0, { isBot: false }),
          commit("api", "ci-acct", 1, 0, { isBot: true }),
        ],
      }),
    );
    const row = rows.find((r) => r.login === "ci-acct")!;
    expect(row.commits).toBe(2);
    expect(row.isBot).toBe(true);
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
    expect(rows[0].activityScore).toBe(4); // 1 commit + 2 opened + 1 merged
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

describe("workByContributor", () => {
  it("maps PR titles + commit headlines into UserTickets, keyed by login", () => {
    const users = workByContributor(
      activity({
        commits: [
          commit("api", "alice", 10, 0, { message: "Add auth guard" }),
          commit("api", "alice", 5, 1, { message: "Fix token refresh" }),
        ],
        pullRequests: [
          pr("api", "alice", { number: 7, title: "Auth hardening", createdAt: "2026-05-12T10:00:00Z" }),
        ],
      }),
    );
    expect(users).toHaveLength(1);
    const alice = users[0];
    expect(alice.accountId).toBe("login:alice");
    expect(alice.displayName).toBe("alice");
    // commits first, then in-period PRs
    expect(alice.tickets.map((t) => t.summary)).toEqual([
      "Add auth guard",
      "Fix token refresh",
      "Auth hardening",
    ]);
    expect(alice.tickets.at(-1)!.key).toBe("api#7");
  });

  it("skips bots and out-of-period PRs", () => {
    const users = workByContributor(
      activity({
        commits: [commit("api", "dependabot[bot]", 3, 0, { isBot: true })],
        pullRequests: [
          // opened + merged before the period: excluded
          pr("api", "alice", {
            number: 1,
            createdAt: "2026-04-01T10:00:00Z",
            mergedAt: "2026-04-02T10:00:00Z",
          }),
          // merged in-period: included even though opened earlier
          pr("api", "bob", {
            number: 2,
            createdAt: "2026-04-20T10:00:00Z",
            mergedAt: "2026-05-09T10:00:00Z",
            title: "Ship it",
          }),
        ],
      }),
    );
    expect(users.map((u) => u.accountId)).toEqual(["login:bob"]);
    expect(users[0].tickets).toEqual([{ key: "api#2", summary: "Ship it" }]);
  });

  it("groups unlinked commit authors under name:<author>", () => {
    const users = workByContributor(
      activity({
        commits: [commit("api", null, 4, 1, { name: "No Account", message: "Tweak config" })],
      }),
    );
    expect(users[0].accountId).toBe("name:No Account");
    expect(users[0].displayName).toBe("No Account");
  });
});
