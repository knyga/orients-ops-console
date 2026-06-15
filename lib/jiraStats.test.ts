import { describe, expect, it } from "vitest";
import {
  aggregateByUser,
  sprintChurn,
  ticketsByUser,
  type JiraIssue,
} from "./jiraStats";

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

  it("collects each user's resolved issue keys in encounter order", () => {
    const { rows } = aggregateByUser([
      issue({ key: "ATP-1" }),
      issue({ key: "MC-1", assignee: { accountId: "u2", displayName: "Bob" } }),
      issue({ key: "ATP-2" }),
    ]);
    const alice = rows.find((r) => r.accountId === "u1");
    const bob = rows.find((r) => r.accountId === "u2");
    expect(alice?.issueKeys).toEqual(["ATP-1", "ATP-2"]);
    expect(bob?.issueKeys).toEqual(["MC-1"]);
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

describe("ticketsByUser", () => {
  it("groups key+summary per user, Unassigned for no assignee, in encounter order", () => {
    const groups = ticketsByUser([
      issue({ key: "ATP-1", summary: "Fix A" }),
      issue({
        key: "MC-1",
        summary: "Build B",
        assignee: { accountId: "u2", displayName: "Bob" },
      }),
      issue({ key: "ATP-2", summary: "Fix C" }),
      issue({ key: "ATP-3", summary: "Orphan", assignee: null }),
    ]);
    const alice = groups.find((g) => g.accountId === "u1");
    const bob = groups.find((g) => g.accountId === "u2");
    const unassigned = groups.find((g) => g.accountId === null);
    expect(alice).toEqual({
      accountId: "u1",
      displayName: "Alice",
      tickets: [
        { key: "ATP-1", summary: "Fix A" },
        { key: "ATP-2", summary: "Fix C" },
      ],
    });
    expect(bob?.tickets).toEqual([{ key: "MC-1", summary: "Build B" }]);
    expect(unassigned?.displayName).toBe("Unassigned");
  });
});

describe("sprintChurn", () => {
  it("omits issues with no Sprint changelog entry", () => {
    const result = sprintChurn([
      issue({
        key: "ATP-1",
        histories: [
          {
            created: "2026-06-01T10:00:00.000+0000",
            items: [{ field: "status", fromString: "To Do", toString: "Done" }],
          },
        ],
      }),
    ]);
    expect(result).toEqual([]);
  });

  it("extracts a single sprint move", () => {
    const result = sprintChurn([
      issue({
        key: "ATP-1630",
        summary: "Telemetry fix",
        histories: [
          {
            created: "2026-06-09T08:00:00.000+0000",
            items: [{ field: "Sprint", fromString: "ATP 37", toString: "ATP 38" }],
          },
        ],
      }),
    ]);
    expect(result).toEqual([
      {
        issueKey: "ATP-1630",
        summary: "Telemetry fix",
        changes: [{ from: "ATP 37", to: "ATP 38", when: "2026-06-09T08:00:00.000+0000" }],
      },
    ]);
  });

  it("collects multiple moves ordered by time, ignoring non-Sprint items", () => {
    const result = sprintChurn([
      issue({
        key: "ATP-2",
        histories: [
          {
            created: "2026-06-10T00:00:00.000+0000",
            items: [{ field: "Sprint", fromString: "ATP 38", toString: "ATP 39" }],
          },
          {
            created: "2026-06-05T00:00:00.000+0000",
            items: [
              { field: "assignee", fromString: "Alice", toString: "Bob" },
              { field: "Sprint", fromString: "ATP 37", toString: "ATP 38" },
            ],
          },
        ],
      }),
    ]);
    expect(result[0].changes).toEqual([
      { from: "ATP 37", to: "ATP 38", when: "2026-06-05T00:00:00.000+0000" },
      { from: "ATP 38", to: "ATP 39", when: "2026-06-10T00:00:00.000+0000" },
    ]);
  });

  it("renders null from/to (added to / removed from a sprint) as empty strings", () => {
    const result = sprintChurn([
      issue({
        key: "ATP-3",
        histories: [
          {
            created: "2026-06-02T00:00:00.000+0000",
            items: [{ field: "Sprint", fromString: null, toString: "ATP 38" }],
          },
        ],
      }),
    ]);
    expect(result[0].changes).toEqual([
      { from: "", to: "ATP 38", when: "2026-06-02T00:00:00.000+0000" },
    ]);
  });
});
