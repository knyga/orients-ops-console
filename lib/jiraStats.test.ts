import { describe, expect, it } from "vitest";
import { aggregateByUser, type JiraIssue } from "./jiraStats";

/** A resolved issue with sensible defaults; override per test. */
function issue(over: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key: "ATP-1",
    summary: "Some issue",
    assignee: { accountId: "u1", displayName: "Alice" },
    storyPoints: null,
    histories: [],
    ...over,
  };
}

describe("aggregateByUser", () => {
  it("sums resolved count and story points per user", () => {
    const { rows } = aggregateByUser([
      issue({ key: "ATP-1", storyPoints: 3 }),
      issue({ key: "ATP-2", storyPoints: 5 }),
      issue({
        key: "MC-1",
        assignee: { accountId: "u2", displayName: "Bob" },
        storyPoints: 2,
      }),
    ]);
    const alice = rows.find((r) => r.accountId === "u1");
    const bob = rows.find((r) => r.accountId === "u2");
    expect(alice).toMatchObject({ resolvedCount: 2, storyPoints: 8 });
    expect(bob).toMatchObject({ resolvedCount: 1, storyPoints: 2 });
  });

  it("treats null/undefined story points as 0", () => {
    const { rows } = aggregateByUser([
      issue({ storyPoints: null }),
      issue({ key: "ATP-2", storyPoints: 4 }),
    ]);
    expect(rows[0].storyPoints).toBe(4);
    expect(rows[0].resolvedCount).toBe(2);
  });

  it("buckets assignee-less issues under Unassigned", () => {
    const { rows } = aggregateByUser([issue({ assignee: null, storyPoints: 1 })]);
    expect(rows[0]).toMatchObject({
      accountId: null,
      displayName: "Unassigned",
      resolvedCount: 1,
      storyPoints: 1,
    });
  });

  it("returns period totals across all users", () => {
    const { totals } = aggregateByUser([
      issue({ key: "ATP-1", storyPoints: 3 }),
      issue({
        key: "MC-1",
        assignee: { accountId: "u2", displayName: "Bob" },
        storyPoints: 5,
      }),
    ]);
    expect(totals).toEqual({ totalResolved: 2, totalStoryPoints: 8 });
  });

  it("sorts rows by resolved count desc, then displayName asc", () => {
    const { rows } = aggregateByUser([
      issue({ key: "ATP-1", assignee: { accountId: "u1", displayName: "Alice" } }),
      issue({ key: "MC-1", assignee: { accountId: "u2", displayName: "Bob" } }),
      issue({ key: "MC-2", assignee: { accountId: "u2", displayName: "Bob" } }),
    ]);
    expect(rows.map((r) => r.displayName)).toEqual(["Bob", "Alice"]);
  });
});
