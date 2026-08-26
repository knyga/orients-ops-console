import { describe, expect, it } from "vitest";
import {
  slugifySprint,
  isDone,
  computeCompletion,
  buildCommittedPost,
  buildCompletedPost,
  pluralizeSprints,
  type SprintIssue,
  type SprintSnapshot,
} from "./sprintReport";
import { mention } from "./mention";
import { byteLength, SLACK_MSG_MAX_BYTES } from "./slackChunk";
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

/** How many times each issue key appears as a bullet across the thread messages. */
function issueKeyCounts(parts: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of parts.join("\n").matchAll(/• (?:[^•\n]*? - )?(ATP-\d+) —/g)) {
    counts[m[1]] = (counts[m[1]] ?? 0) + 1;
  }
  return counts;
}

/** Every key ATP-1..ATP-n exactly once. */
function expectedCounts(n: number): Record<string, number> {
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [`ATP-${i + 1}`, 1]));
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

describe("buildCommittedPost", () => {
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

  it("keeps the anchor to headline + per-assignee counts, no issue keys", () => {
    const text = buildCommittedPost(snapshot).anchor;
    expect(text).toContain("📋 Спринт *ATP 42* — взято в роботу: 3 задач");
    expect(text).toContain("• Taras — 2");
    expect(text).toContain("• Не призначено — 1");
    expect(text).not.toContain("ATP-1");
    expect(text).not.toContain("Login");
  });

  it("renders the details as thread messages grouped by assignee then status", () => {
    const parts = buildCommittedPost(snapshot).details;
    expect(parts.length).toBe(1);
    const text = parts[0];
    expect(text).toContain("*Taras*");
    expect(text).toContain("In Progress");
    expect(text).toContain("    • ATP-1 — Login");
    expect(text).toContain("*Не призначено*");
    // Assignee header appears once, statuses nested under it.
    expect(text.match(/\*Taras\*/g)?.length).toBe(1);
  });

  it("mentions a known assignee in both the anchor and the details", () => {
    const acc = "712020:2c9fa200-866c-4d8b-b00a-bd7d434220b0";
    const snap: SprintSnapshot = {
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
    const p = personForJiraAccountId(acc)!;
    expect(buildCommittedPost(snap).anchor).toContain(`• Volodymyr Pavliukevych (${mention(p)}) — 1`);
    expect(buildCommittedPost(snap).details[0]).toContain(`*Volodymyr Pavliukevych (${mention(p)})*`);
  });

  it("splits the details across messages that each fit Slack's byte cap", () => {
    const many: SprintIssue[] = [];
    for (let i = 1; i <= 120; i++) {
      many.push(
        issue({
          key: `ATP-${i}`,
          summary: "Дуже довгий опис задачі, який займає багато байтів у UTF-8",
          assignee: { accountId: `a${i % 6}`, displayName: `Person ${i % 6}` },
        }),
      );
    }
    const snap: SprintSnapshot = { ...snapshot, issues: many };
    const parts = buildCommittedPost(snap).details;
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(byteLength(p)).toBeLessThanOrEqual(SLACK_MSG_MAX_BYTES);
    // Every issue appears EXACTLY once across the thread — nothing dropped at a
    // packing boundary, nothing duplicated into the next message.
    expect(issueKeyCounts(parts)).toEqual(expectedCounts(120));
  });
});

describe("buildCompletedPost", () => {
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

  it("keeps the anchor to the rate, per-person rates and a stuck count", () => {
    const text = buildCompletedPost("ATP 42", computeCompletion(frozen, live)).anchor;
    expect(text).toContain("✅ Спринт *ATP 42* — виконано 2/4 (50%)");
    expect(text).toContain("• Taras — 2/4 (50%)");
    expect(text).toContain("⚠️ Зависли (кілька спринтів): 1");
    expect(text).toContain("🧵 Деталі — у треді.");
    // No per-issue detail in the anchor.
    expect(text).not.toContain("ATP-1");
    expect(text).not.toContain("No progress");
  });

  it("renders per-person buckets in the details: done-by-status, transitions, no progress", () => {
    const parts = buildCompletedPost("ATP 42", computeCompletion(frozen, live)).details;
    expect(parts.length).toBe(1);
    const lines = parts[0].split("\n");
    expect(parts[0]).toContain("*Taras* — 2/4 (50%)");
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

  it("renders stuck lines in the details as status - assignee - key — summary (N спринтів)", () => {
    const text = buildCompletedPost("ATP 42", computeCompletion(frozen, live)).details.join("\n");
    expect(text).toContain("⚠️ Зависли (кілька спринтів):");
    expect(text).toContain("  • Review - Taras - ATP-2 — Signup (2 спринти)");
  });

  it("labels a known assignee as Name (<@ID>) in the anchor and the details", () => {
    const acc = "712020:2c9fa200-866c-4d8b-b00a-bd7d434220b0";
    const person = personForJiraAccountId(acc)!;
    const who = { accountId: acc, displayName: "Volodymyr Pavliukevych" };
    const fr = [issue({ key: "ATP-1", assignee: who })];
    const lv = [issue({ key: "ATP-1", assignee: who, statusName: "Done", statusCategory: "Done" })];
    const result = computeCompletion(fr, lv);
    expect(buildCompletedPost("ATP 43", result).anchor).toContain(
      `• Volodymyr Pavliukevych (${mention(person)}) — 1/1 (100%)`,
    );
    expect(buildCompletedPost("ATP 42", result).details[0]).toContain(
      `*Volodymyr Pavliukevych (${mention(person)})* — 1/1 (100%)`,
    );
  });

  it("keeps the zero-done line in the anchor and still details the per-person blocks", () => {
    const fr = [issue({ key: "ATP-1", assignee: A, statusName: "To Do" })];
    const lv = [issue({ key: "ATP-1", assignee: A, statusName: "To Do" })];
    const result = computeCompletion(fr, lv);
    expect(buildCompletedPost("ATP 42", result).anchor).toContain("_Жодної задачі не завершено._");
    expect(buildCompletedPost("ATP 42", result).anchor).toContain("• Taras — 0/1 (0%)");
    const details = buildCompletedPost("ATP 42", result).details[0];
    expect(details).toContain("*Taras* — 0/1 (0%)");
    expect(details).toContain("  No progress:");
  });

  it("omits the stuck section from both surfaces when nothing is stuck", () => {
    const fr: SprintIssue[] = [issue({ key: "ATP-1", assignee: A, sprintCount: 1 })];
    const lv: SprintIssue[] = [
      issue({ key: "ATP-1", assignee: A, statusName: "Done", statusCategory: "Done", sprintCount: 1 }),
    ];
    const result = computeCompletion(fr, lv);
    expect(buildCompletedPost("ATP 42", result).anchor).not.toContain("Зависли");
    expect(buildCompletedPost("ATP 42", result).details.join("\n")).not.toContain("Зависли");
  });

  it("repeats the header on a section that spills into the next message", () => {
    const fr: SprintIssue[] = [];
    const lv: SprintIssue[] = [];
    for (let i = 1; i <= 90; i++) {
      const summary = "Дуже довгий опис задачі, яка зависла на кілька спринтів підряд, багато байтів";
      fr.push(issue({ key: `ATP-${i}`, summary, assignee: A, statusName: "To Do", sprintCount: 2 }));
      lv.push(issue({ key: `ATP-${i}`, summary, assignee: A, statusName: "To Do", sprintCount: 2 }));
    }
    const parts = buildCompletedPost("ATP 42", computeCompletion(fr, lv)).details;
    const stuckParts = parts.filter((p) => p.includes("Зависли"));
    expect(stuckParts.length).toBeGreaterThan(1);
    // Every spilled message opens with the continuation header, never an orphan line.
    for (const p of stuckParts.slice(1)) {
      expect(p.split("\n")[0]).toBe("⚠️ Зависли (кілька спринтів) _(продовження)_:");
    }
  });

  it("splits the details across messages that each fit Slack's byte cap", () => {
    const fr: SprintIssue[] = [];
    const lv: SprintIssue[] = [];
    for (let i = 1; i <= 120; i++) {
      const who = { accountId: `a${i % 6}`, displayName: `Person ${i % 6}` };
      const summary = "Дуже довгий опис задачі, який займає багато байтів у UTF-8";
      fr.push(issue({ key: `ATP-${i}`, summary, assignee: who, statusName: "To Do" }));
      lv.push(issue({ key: `ATP-${i}`, summary, assignee: who, statusName: "To Do" }));
    }
    const parts = buildCompletedPost("ATP 42", computeCompletion(fr, lv)).details;
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(byteLength(p)).toBeLessThanOrEqual(SLACK_MSG_MAX_BYTES);
    // Exactly once each: no boundary loss, no duplication.
    expect(issueKeyCounts(parts)).toEqual(expectedCounts(120));
  });
});

describe("anchor byte cap", () => {
  /** Many assignees, each with a long Cyrillic name → an unbounded roster. */
  function bigRoster(count: number): SprintIssue[] {
    return Array.from({ length: count }, (_, i) =>
      issue({
        key: `ATP-${i + 1}`,
        summary: "Задача",
        assignee: {
          accountId: `acc-${i}`,
          displayName: `Володимир Павлюкевич-Форостяний ${i}`,
        },
      }),
    );
  }

  it("keeps the committed anchor within the cap by shedding the roster into the thread", () => {
    const snapshot: SprintSnapshot = {
      sprintId: 1,
      sprintName: "ATP 99",
      slug: "ATP-99",
      capturedAt: "2026-08-26T06:00:00.000Z",
      issues: bigRoster(120),
    };
    const post = buildCommittedPost(snapshot);
    expect(byteLength(post.anchor)).toBeLessThanOrEqual(SLACK_MSG_MAX_BYTES);
    // The roster moved to the FIRST thread message, headline stayed in the anchor.
    expect(post.anchor).toContain("взято в роботу: 120 задач");
    expect(post.anchor).not.toContain("• Володимир");
    expect(post.details[0]).toContain("👥 Розподіл задач:");
    expect(post.details[0]).toContain("• Володимир Павлюкевич-Форостяний 0 — 1");
  });

  it("keeps the completed anchor within the cap by shedding the roster into the thread", () => {
    const many = bigRoster(120);
    const post = buildCompletedPost("ATP 99", computeCompletion(many, many));
    expect(byteLength(post.anchor)).toBeLessThanOrEqual(SLACK_MSG_MAX_BYTES);
    expect(post.anchor).toContain("виконано 0/120 (0%)");
    expect(post.anchor).not.toContain("• Володимир");
    expect(post.details[0]).toContain("👥 Прогрес по людях:");
  });

  it("keeps the roster in the anchor when it fits", () => {
    const snapshot: SprintSnapshot = {
      sprintId: 1,
      sprintName: "ATP 99",
      slug: "ATP-99",
      capturedAt: "2026-08-26T06:00:00.000Z",
      issues: [issue({ key: "ATP-1", assignee: A })],
    };
    const post = buildCommittedPost(snapshot);
    expect(post.anchor).toContain("• Taras — 1");
    expect(post.details[0]).not.toContain("👥");
  });

  it("promises a thread only when there is one", () => {
    const empty: SprintSnapshot = {
      sprintId: 1,
      sprintName: "ATP 99",
      slug: "ATP-99",
      capturedAt: "2026-08-26T06:00:00.000Z",
      issues: [],
    };
    const post = buildCommittedPost(empty);
    expect(post.details).toEqual([]);
    expect(post.anchor).not.toContain("🧵");
    const completed = buildCompletedPost("ATP 99", computeCompletion([], []));
    expect(completed.details).toEqual([]);
    expect(completed.anchor).not.toContain("🧵");
    // A populated post still points at its thread.
    expect(buildCommittedPost({ ...empty, issues: [issue({ key: "ATP-1", assignee: A })] }).anchor)
      .toContain("🧵");
  });

  it("gives every piece of a pathologically long line its own header", () => {
    const long = issue({ key: "ATP-1", summary: "я".repeat(4000), assignee: A });
    const parts = buildCommittedPost({
      sprintId: 1,
      sprintName: "ATP 99",
      slug: "ATP-99",
      capturedAt: "2026-08-26T06:00:00.000Z",
      issues: [long],
    }).details;
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(byteLength(p)).toBeLessThanOrEqual(SLACK_MSG_MAX_BYTES);
      // Never a header-only message, never a headerless fragment.
      expect(p.split("\n")[0]).toMatch(/^\*Taras\*/);
      expect(p.split("\n").length).toBeGreaterThan(1);
    }
    // Lossless: the summary survives concatenation of the pieces.
    const body = parts.map((p) => p.split("\n").slice(1).join("\n")).join("");
    expect(body).toContain("я".repeat(4000));
  });
});
