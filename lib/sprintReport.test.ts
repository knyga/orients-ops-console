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

  it("lists every committed assignee, unassigned last", () => {
    const fr: SprintIssue[] = [
      issue({ key: "ATP-1", assignee: A }),
      issue({ key: "ATP-2", assignee: null }),
      issue({ key: "ATP-3", assignee: B }),
    ];
    const live: SprintIssue[] = [
      issue({ key: "ATP-1", assignee: A, statusCategory: "Done", statusName: "Done" }),
      // ATP-2 untouched, ATP-3 untouched → still present in assignees
      issue({ key: "ATP-2", assignee: null }),
      issue({ key: "ATP-3", assignee: B }),
    ];
    const r = computeCompletion(fr, live);
    const names = r.assignees.map((g) => g.displayName);
    expect(names).toEqual(["Taras", "Vlad", "Не призначено"]);
  });

  it("splits done issues by live status name; CANCELLED still counts toward the rate", () => {
    const fr: SprintIssue[] = [
      issue({ key: "ATP-1", assignee: A, statusName: "In Progress", statusCategory: "In Progress" }),
      issue({ key: "ATP-2", assignee: A, statusName: "To Do" }),
    ];
    const live: SprintIssue[] = [
      issue({ key: "ATP-1", assignee: A, statusName: "Done", statusCategory: "Done" }),
      issue({ key: "ATP-2", assignee: A, statusName: "CANCELLED", statusCategory: "Done" }),
    ];
    const r = computeCompletion(fr, live);
    expect(r.completed).toBe(2);
    expect(r.rate).toBe(100);
    const a = r.assignees[0];
    // "Done" bucket first, then other done statuses alphabetically.
    expect(a.doneByStatus.map((b) => b.status)).toEqual(["Done", "CANCELLED"]);
    expect(a.doneByStatus[1].issues).toEqual([{ key: "ATP-2", summary: "Summary of ATP-2" }]);
  });

  it("classifies a moved non-done issue as a transition, grouped by from -> to", () => {
    const fr: SprintIssue[] = [
      issue({ key: "ATP-1", assignee: A, statusName: "QA Blocked", statusCategory: "In Progress" }),
      issue({ key: "ATP-2", assignee: A, statusName: "QA Blocked", statusCategory: "In Progress" }),
      issue({ key: "ATP-3", assignee: A, statusName: "To Do" }),
    ];
    const live: SprintIssue[] = [
      issue({ key: "ATP-1", assignee: A, statusName: "Review", statusCategory: "In Progress" }),
      issue({ key: "ATP-2", assignee: A, statusName: "Review", statusCategory: "In Progress" }),
      issue({ key: "ATP-3", assignee: A, statusName: "In Progress", statusCategory: "In Progress" }),
    ];
    const a = computeCompletion(fr, live).assignees[0];
    expect(a.transitions).toEqual([
      {
        from: "QA Blocked",
        to: "Review",
        issues: [
          { key: "ATP-1", summary: "Summary of ATP-1" },
          { key: "ATP-2", summary: "Summary of ATP-2" },
        ],
      },
      { from: "To Do", to: "In Progress", issues: [{ key: "ATP-3", summary: "Summary of ATP-3" }] },
    ]);
    expect(a.noProgress).toEqual([]);
  });

  it("classifies an unchanged non-done issue (or one missing from live) as no progress", () => {
    const fr: SprintIssue[] = [
      issue({ key: "ATP-1", assignee: A, statusName: "To Do" }),
      issue({ key: "ATP-2", assignee: A, statusName: "In Progress", statusCategory: "In Progress" }),
    ];
    const live: SprintIssue[] = [
      issue({ key: "ATP-1", assignee: A, statusName: "To Do" }),
      // ATP-2 missing from live → frozen fields, no transition
    ];
    const a = computeCompletion(fr, live).assignees[0];
    expect(a.transitions).toEqual([]);
    expect(a.noProgress).toEqual([
      { status: "To Do", key: "ATP-1", summary: "Summary of ATP-1" },
      { status: "In Progress", key: "ATP-2", summary: "Summary of ATP-2" },
    ]);
  });

  it("computes per-person committed/done/rate", () => {
    const fr: SprintIssue[] = [
      issue({ key: "ATP-1", assignee: A }),
      issue({ key: "ATP-2", assignee: A }),
      issue({ key: "ATP-3", assignee: A }),
      issue({ key: "ATP-4", assignee: B }),
    ];
    const live: SprintIssue[] = [
      issue({ key: "ATP-1", assignee: A, statusName: "Done", statusCategory: "Done" }),
      issue({ key: "ATP-2", assignee: A, statusName: "To Do" }),
      issue({ key: "ATP-3", assignee: A, statusName: "To Do" }),
      issue({ key: "ATP-4", assignee: B, statusName: "Done", statusCategory: "Done" }),
    ];
    const r = computeCompletion(fr, live);
    const taras = r.assignees.find((g) => g.displayName === "Taras")!;
    expect(taras.committed).toBe(3);
    expect(taras.done).toBe(1);
    expect(taras.rate).toBe(33);
    const vlad = r.assignees.find((g) => g.displayName === "Vlad")!;
    expect(vlad.rate).toBe(100);
  });

  it("stuck entries carry the live status name and keep the key", () => {
    const fr: SprintIssue[] = [
      issue({ key: "ATP-2", assignee: A, statusName: "To Do", sprintCount: 2 }),
    ];
    const live: SprintIssue[] = [
      issue({ key: "ATP-2", assignee: A, statusName: "QA Blocked", statusCategory: "In Progress", sprintCount: 2 }),
    ];
    const r = computeCompletion(fr, live);
    expect(r.stuck).toEqual([
      {
        key: "ATP-2",
        summary: "Summary of ATP-2",
        displayName: "Taras",
        statusName: "QA Blocked",
        sprintCount: 2,
      },
    ]);
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
    const p = personForJiraAccountId(acc)!;
    expect(msg).toContain(`*Volodymyr Pavliukevych (${mention(p)})*`);
  });
});

describe("formatCompletedMessage", () => {
  const frozen: SprintIssue[] = [
    issue({ key: "ATP-1", summary: "Login", assignee: A, statusName: "In Progress", statusCategory: "In Progress" }),
    issue({ key: "ATP-2", summary: "Signup", assignee: A, statusName: "QA Blocked", statusCategory: "In Progress", sprintCount: 2 }),
    issue({ key: "ATP-3", summary: "Cleanup", assignee: A, statusName: "To Do" }),
    issue({ key: "ATP-4", summary: "Legacy", assignee: A, statusName: "To Do" }),
  ];
  const live: SprintIssue[] = [
    issue({ key: "ATP-1", summary: "Login", assignee: A, statusName: "Done", statusCategory: "Done" }),
    issue({ key: "ATP-2", summary: "Signup", assignee: A, statusName: "Review", statusCategory: "In Progress", sprintCount: 2 }),
    issue({ key: "ATP-3", summary: "Cleanup", assignee: A, statusName: "To Do" }),
    issue({ key: "ATP-4", summary: "Legacy", assignee: A, statusName: "CANCELLED", statusCategory: "Done" }),
  ];

  it("renders per-person buckets: done-by-status, transitions, no progress", () => {
    const text = formatCompletedMessage("ATP 42", computeCompletion(frozen, live));
    expect(text).toContain("✅ Спринт *ATP 42* — виконано 2/4 (50%)");
    expect(text).toContain("*Taras* — 2/4 (50%)");
    const lines = text.split("\n");
    const iDone = lines.indexOf("  Done:");
    const iCancelled = lines.indexOf("  CANCELLED:");
    const iTransition = lines.indexOf("  QA Blocked -> Review:");
    const iNoProgress = lines.indexOf("  No progress:");
    // All four buckets present, in order: Done, CANCELLED, transitions, No progress.
    expect(iDone).toBeGreaterThan(-1);
    expect(iCancelled).toBeGreaterThan(iDone);
    expect(iTransition).toBeGreaterThan(iCancelled);
    expect(iNoProgress).toBeGreaterThan(iTransition);
    expect(lines[iDone + 1]).toBe("    • ATP-1 — Login");
    expect(lines[iCancelled + 1]).toBe("    • ATP-4 — Legacy");
    expect(lines[iTransition + 1]).toBe("    • ATP-2 — Signup");
    expect(lines[iNoProgress + 1]).toBe("    • To Do - ATP-3 — Cleanup");
  });

  it("renders stuck lines as status - assignee - key — summary (N спринтів)", () => {
    const text = formatCompletedMessage("ATP 42", computeCompletion(frozen, live));
    expect(text).toContain("⚠️ Зависли (кілька спринтів):");
    expect(text).toContain("  • Review - Taras - ATP-2 — Signup (2 спринти)");
  });

  it("labels a known assignee as Name (<@ID>) in the completed message", () => {
    const acc = "712020:2c9fa200-866c-4d8b-b00a-bd7d434220b0";
    const person = personForJiraAccountId(acc)!;
    const who = { accountId: acc, displayName: "Volodymyr Pavliukevych" };
    const fr = [issue({ key: "ATP-1", assignee: who })];
    const lv = [issue({ key: "ATP-1", assignee: who, statusName: "Done", statusCategory: "Done" })];
    const text = formatCompletedMessage("ATP 43", computeCompletion(fr, lv));
    expect(text).toContain(`*Volodymyr Pavliukevych (${mention(person)})* — 1/1 (100%)`);
  });

  it("keeps the zero-done line and still lists the per-person blocks", () => {
    const fr = [issue({ key: "ATP-1", assignee: A, statusName: "To Do" })];
    const lv = [issue({ key: "ATP-1", assignee: A, statusName: "To Do" })];
    const text = formatCompletedMessage("ATP 42", computeCompletion(fr, lv));
    expect(text).toContain("_Жодної задачі не завершено._");
    expect(text).toContain("*Taras* — 0/1 (0%)");
    expect(text).toContain("  No progress:");
  });

  it("omits the stuck section when nothing is stuck", () => {
    const fr: SprintIssue[] = [issue({ key: "ATP-1", assignee: A, sprintCount: 1 })];
    const lv: SprintIssue[] = [
      issue({ key: "ATP-1", assignee: A, statusName: "Done", statusCategory: "Done", sprintCount: 1 }),
    ];
    const text = formatCompletedMessage("ATP 42", computeCompletion(fr, lv));
    expect(text).not.toContain("Зависли");
  });
});
