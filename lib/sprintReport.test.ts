import { describe, expect, it } from "vitest";
import {
  slugifySprint,
  isDone,
  computeCompletion,
  formatCommittedMessage,
  formatCompletedMessage,
  pluralizeSprints,
  type SprintIssue,
  type SprintSnapshot,
} from "./sprintReport";
import { mention } from "./mention";
import { personForJiraAccountId } from "./people";

function issue(partial: Partial<SprintIssue> & { key: string }): SprintIssue {
  return {
    key: partial.key,
    summary: partial.summary ?? `Summary of ${partial.key}`,
    assignee: partial.assignee ?? null,
    statusName: partial.statusName ?? "To Do",
    statusCategory: partial.statusCategory ?? "To Do",
    sprintCount: partial.sprintCount ?? 1,
  };
}

const A = { accountId: "a1", displayName: "Taras" };
const B = { accountId: "b1", displayName: "Vlad" };

describe("slugifySprint", () => {
  it("turns a sprint name into a filesystem-safe slug", () => {
    expect(slugifySprint("ATP 42")).toBe("ATP-42");
    expect(slugifySprint("ATP Sprint 7")).toBe("ATP-Sprint-7");
    expect(slugifySprint("  ATP  9 ")).toBe("ATP-9");
  });
});

describe("isDone", () => {
  it("matches the Done status category case-insensitively", () => {
    expect(isDone("Done")).toBe(true);
    expect(isDone("done")).toBe(true);
    expect(isDone("In Progress")).toBe(false);
    expect(isDone("To Do")).toBe(false);
  });
});

describe("pluralizeSprints", () => {
  it("uses Ukrainian plural forms", () => {
    expect(pluralizeSprints(2)).toBe("2 спринти");
    expect(pluralizeSprints(3)).toBe("3 спринти");
    expect(pluralizeSprints(4)).toBe("4 спринти");
    expect(pluralizeSprints(5)).toBe("5 спринтів");
    expect(pluralizeSprints(11)).toBe("11 спринтів");
  });
});

describe("computeCompletion", () => {
  const frozen: SprintIssue[] = [
    issue({ key: "ATP-1", assignee: A, sprintCount: 1 }),
    issue({ key: "ATP-2", assignee: A, sprintCount: 2 }),
    issue({ key: "ATP-3", assignee: B, sprintCount: 1 }),
    issue({ key: "ATP-4", assignee: B, sprintCount: 3 }),
  ];

  it("counts done issues against the frozen denominator", () => {
    const live: SprintIssue[] = [
      issue({ key: "ATP-1", assignee: A, statusCategory: "Done" }),
      issue({ key: "ATP-2", assignee: A, statusCategory: "In Progress", sprintCount: 2 }),
      issue({ key: "ATP-3", assignee: B, statusCategory: "Done" }),
      issue({ key: "ATP-4", assignee: B, statusCategory: "To Do", sprintCount: 3 }),
    ];
    const r = computeCompletion(frozen, live);
    expect(r.committed).toBe(4);
    expect(r.completed).toBe(2);
    expect(r.rate).toBe(50);
  });

  it("treats a frozen issue missing from live re-fetch as not done", () => {
    const live: SprintIssue[] = [
      issue({ key: "ATP-1", assignee: A, statusCategory: "Done" }),
      // ATP-2/3/4 removed from the sprint / deleted → absent
    ];
    const r = computeCompletion(frozen, live);
    expect(r.committed).toBe(4);
    expect(r.completed).toBe(1);
    expect(r.rate).toBe(25);
  });

  it("guards against divide-by-zero on an empty sprint", () => {
    const r = computeCompletion([], []);
    expect(r.committed).toBe(0);
    expect(r.completed).toBe(0);
    expect(r.rate).toBe(0);
  });

  it("flags only incomplete issues carried across >=2 sprints, with the live count", () => {
    const live: SprintIssue[] = [
      issue({ key: "ATP-1", assignee: A, statusCategory: "Done", sprintCount: 1 }),
      issue({ key: "ATP-2", assignee: A, statusCategory: "In Progress", sprintCount: 2 }),
      issue({ key: "ATP-3", assignee: B, statusCategory: "To Do", sprintCount: 1 }),
      issue({ key: "ATP-4", assignee: B, statusCategory: "To Do", sprintCount: 3 }),
    ];
    const r = computeCompletion(frozen, live);
    // ATP-2 (2 sprints, not done) and ATP-4 (3 sprints, not done) are stuck.
    // ATP-3 is not done but first sprint → not stuck. ATP-1 done → not stuck.
    expect(r.stuck.map((s) => s.key)).toEqual(["ATP-2", "ATP-4"]);
    expect(r.stuck.find((s) => s.key === "ATP-2")?.sprintCount).toBe(2);
    expect(r.stuck.find((s) => s.key === "ATP-4")?.sprintCount).toBe(3);
  });

  it("does not flag a done issue even if it lived in many sprints", () => {
    const live: SprintIssue[] = [
      issue({ key: "ATP-4", assignee: B, statusCategory: "Done", sprintCount: 5 }),
    ];
    const r = computeCompletion([issue({ key: "ATP-4", assignee: B, sprintCount: 5 })], live);
    expect(r.stuck).toEqual([]);
  });

  it("groups done issues by assignee, unassigned last", () => {
    const fr: SprintIssue[] = [
      issue({ key: "ATP-1", assignee: A }),
      issue({ key: "ATP-2", assignee: null }),
      issue({ key: "ATP-3", assignee: B }),
    ];
    const live: SprintIssue[] = [
      issue({ key: "ATP-1", assignee: A, statusCategory: "Done" }),
      issue({ key: "ATP-2", assignee: null, statusCategory: "Done" }),
      issue({ key: "ATP-3", assignee: B, statusCategory: "Done" }),
    ];
    const r = computeCompletion(fr, live);
    const names = r.byAssignee.map((g) => g.displayName);
    expect(names[names.length - 1]).toBe("Не призначено");
    expect(names).toContain("Taras");
    expect(names).toContain("Vlad");
  });
});

describe("formatCommittedMessage", () => {
  const snapshot: SprintSnapshot = {
    sprintId: 10,
    sprintName: "ATP 42",
    slug: "ATP-42",
    capturedAt: "2026-07-20T18:00:00.000Z",
    issues: [
      issue({ key: "ATP-1", summary: "Login", assignee: A, statusName: "In Progress" }),
      issue({ key: "ATP-2", summary: "Signup", assignee: A, statusName: "To Do" }),
      issue({ key: "ATP-3", summary: "Docs", assignee: null, statusName: "To Do" }),
    ],
  };

  it("renders a Ukrainian committed message grouped by assignee then status", () => {
    const text = formatCommittedMessage(snapshot);
    expect(text).toContain("ATP 42");
    expect(text).toContain("3"); // count
    expect(text).toContain("Taras");
    expect(text).toContain("In Progress");
    expect(text).toContain("ATP-1");
    expect(text).toContain("Login");
    expect(text).toContain("Не призначено");
    // Assignee header appears once, statuses nested under it.
    expect(text.match(/Taras/g)?.length).toBe(1);
  });

  it("mentions a known assignee in the committed message", () => {
    const acc = "712020:2c9fa200-866c-4d8b-b00a-bd7d434220b0";
    const snapshot: SprintSnapshot = {
      sprintId: 11,
      sprintName: "ATP 43",
      slug: "ATP-43",
      capturedAt: "2026-07-27T18:00:00.000Z",
      issues: [
        issue({
          key: "ATP-1",
          summary: "x",
          assignee: { accountId: acc, displayName: "Volodymyr Pavliukevych" },
          statusName: "Done",
          statusCategory: "Done",
        }),
      ],
    };
    const msg = formatCommittedMessage(snapshot);
    expect(msg).toContain(`*${mention(personForJiraAccountId(acc)!)}*`);
  });
});

describe("formatCompletedMessage", () => {
  it("renders a Ukrainian completed message with rate, per-assignee done, and stuck section", () => {
    const frozen: SprintIssue[] = [
      issue({ key: "ATP-1", summary: "Login", assignee: A, sprintCount: 1 }),
      issue({ key: "ATP-2", summary: "Signup", assignee: A, sprintCount: 2 }),
    ];
    const live: SprintIssue[] = [
      issue({ key: "ATP-1", summary: "Login", assignee: A, statusCategory: "Done", sprintCount: 1 }),
      issue({ key: "ATP-2", summary: "Signup", assignee: A, statusCategory: "To Do", sprintCount: 2 }),
    ];
    const r = computeCompletion(frozen, live);
    const text = formatCompletedMessage("ATP 42", r);
    expect(text).toContain("ATP 42");
    expect(text).toContain("1/2");
    expect(text).toContain("50%");
    expect(text).toContain("Taras");
    expect(text).toContain("ATP-1");
    // stuck section present with the carried issue + sprint count
    expect(text).toContain("ATP-2");
    expect(text).toContain("2 спринти");
  });

  it("omits the stuck section when nothing is stuck", () => {
    const frozen: SprintIssue[] = [issue({ key: "ATP-1", assignee: A, sprintCount: 1 })];
    const live: SprintIssue[] = [
      issue({ key: "ATP-1", assignee: A, statusCategory: "Done", sprintCount: 1 }),
    ];
    const text = formatCompletedMessage("ATP 42", computeCompletion(frozen, live));
    expect(text).not.toContain("Зависли");
  });
});
