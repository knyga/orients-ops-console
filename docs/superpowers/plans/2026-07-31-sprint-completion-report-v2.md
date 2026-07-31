# Sprint Completion Report v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Sunday sprint completion report shows every committed issue per person — done split by status (Done:/CANCELLED:), status transitions for moved issues, a No progress list — plus per-person completion rates, `Name (<@SLACK_ID>)` assignee labels, and a stuck list with status + assignee + key.

**Architecture:** All classification stays in the pure `lib/sprintReport.ts` (`computeCompletion` returns a new `assignees: AssigneeCompletion[]` shape replacing `byAssignee`); `formatCompletedMessage` renders the new Slack layout; the web tab renders the same stored `CompletionResult` with a legacy fallback for old DB records. Spec: `docs/superpowers/specs/2026-07-31-sprint-completion-report-v2-design.md`.

**Tech Stack:** TypeScript strict, Vitest, Next.js 16 App Router (client page), Slack mrkdwn.

## Global Constraints

- `lib/sprintReport.ts` stays **pure**: no React/Next/node imports (only `./mention`, `./people` as today).
- Completion **metric unchanged**: any live status in Jira's Done CATEGORY (incl. CANCELLED) counts as виконано.
- Message text Ukrainian; section headers are **English Jira status names verbatim** (`Done:`, `CANCELLED:`, `QA Blocked -> Review:`, `No progress:`).
- Slack mention markup (`<@ID>`) only in Slack messages — the **web renders plain names** (lib/mention.ts discipline).
- Legacy stored `SprintRecord.completed.result` rows (old shape with `byAssignee`) must still render on the web; no DB migration.
- Deterministic ordering everywhere: assignees by display name with «Не призначено» last; done statuses `Done` first then alphabetical; transitions alphabetical by `{from} -> {to}`.

---

### Task 1: `computeCompletion` v2 — per-assignee classification

**Files:**
- Modify: `lib/sprintReport.ts` (types + `computeCompletion`; leave `formatCommittedMessage`, `formatCompletedMessage`, `groupByAssignee` untouched for now — `formatCompletedMessage` must still compile, so update its `result.byAssignee` reference in THIS task, minimal edit shown in Step 3)
- Test: `lib/sprintReport.test.ts`

**Interfaces:**
- Consumes: existing `SprintIssue`, `isDone`, `groupByAssignee` sorting rule.
- Produces (Task 2 + Task 3 rely on these exact shapes):

```ts
export interface IssueRef { key: string; summary: string }

export interface AssigneeCompletion {
  accountId: string | null;
  displayName: string;
  /** Frozen issues attributed to this person. */
  committed: number;
  /** Done-category count. */
  done: number;
  /** Whole-percent per-person rate (0 when committed === 0). */
  rate: number;
  /** Done-category issues grouped by live status name; "Done" first, rest alphabetical. */
  doneByStatus: { status: string; issues: IssueRef[] }[];
  /** Non-done issues whose status changed since the freeze; alphabetical by "from -> to". */
  transitions: { from: string; to: string; issues: IssueRef[] }[];
  /** Non-done issues with an unchanged status; `status` is the current status name. */
  noProgress: { status: string; key: string; summary: string }[];
}

export interface StuckIssue {
  key: string;
  summary: string;
  displayName: string;
  /** Live status name (frozen fallback when absent from live). */
  statusName: string;
  sprintCount: number;
}

export interface CompletionResult {
  committed: number;
  completed: number;
  rate: number;
  /** Every committed assignee (not only those with done issues); unassigned last. */
  assignees: AssigneeCompletion[];
  stuck: StuckIssue[];
}
```

- [ ] **Step 1: Write the failing tests**

In `lib/sprintReport.test.ts`, replace the `computeCompletion` test `"groups done issues by assignee, unassigned last"` (it reads the removed `r.byAssignee`) and add classification tests. Final `computeCompletion` describe block gains/changes these tests (keep the existing four passing tests — `counts done…`, `treats a frozen issue missing…`, `guards against divide-by-zero…`, `flags only incomplete…`, `does not flag a done issue…` — unchanged):

```ts
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
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run lib/sprintReport.test.ts`
Expected: FAIL — TypeScript errors on `r.assignees` / `statusName` (properties don't exist yet).

- [ ] **Step 3: Implement**

In `lib/sprintReport.ts`, replace the `AssigneeGroup`-based result types (`StuckIssue`, `CompletionResult`) and `computeCompletion`. Keep `AssigneeGroup` + `groupByAssignee` exports — `formatCommittedMessage` still uses them.

```ts
export interface IssueRef {
  key: string;
  summary: string;
}

export interface AssigneeCompletion {
  accountId: string | null;
  displayName: string;
  /** Frozen issues attributed to this person. */
  committed: number;
  /** Done-category count. */
  done: number;
  /** Whole-percent per-person rate (0 when committed === 0). */
  rate: number;
  /** Done-category issues grouped by live status name; "Done" first, rest alphabetical. */
  doneByStatus: { status: string; issues: IssueRef[] }[];
  /** Non-done issues whose status changed since the freeze; alphabetical by "from -> to". */
  transitions: { from: string; to: string; issues: IssueRef[] }[];
  /** Non-done issues with an unchanged status; `status` is the current status name. */
  noProgress: { status: string; key: string; summary: string }[];
}

export interface StuckIssue {
  key: string;
  summary: string;
  displayName: string;
  /** Live status name (frozen fallback when absent from live). */
  statusName: string;
  sprintCount: number;
}

export interface CompletionResult {
  committed: number;
  completed: number;
  /** Whole-percent completion rate (0 when nothing committed). */
  rate: number;
  /** Every committed assignee (not only those with done issues); unassigned last. */
  assignees: AssigneeCompletion[];
  /** Incomplete issues carried across >= 2 sprints. */
  stuck: StuckIssue[];
}
```

New `computeCompletion` (replaces the whole function body):

```ts
/**
 * Measure completion of a frozen baseline against a live re-fetch, classifying
 * every frozen issue per assignee: done (grouped by live status name — CANCELLED
 * etc. still count toward the rate), transitioned (frozen status ≠ live status),
 * or no progress. A frozen key absent from `live` keeps its frozen fields, so it
 * counts as not done with no transition.
 */
export function computeCompletion(frozen: SprintIssue[], live: SprintIssue[]): CompletionResult {
  const liveByKey = new Map(live.map((i) => [i.key, i]));
  const committed = frozen.length;

  interface Acc {
    accountId: string | null;
    displayName: string;
    committed: number;
    done: number;
    doneByStatus: Map<string, IssueRef[]>;
    transitions: Map<string, { from: string; to: string; issues: IssueRef[] }>;
    noProgress: { status: string; key: string; summary: string }[];
  }
  const accs = new Map<string, Acc>();
  const stuck: StuckIssue[] = [];
  let completed = 0;

  for (const f of frozen) {
    // Prefer the live status/assignee/summary; fall back to the frozen snapshot.
    const merged = liveByKey.get(f.key) ?? f;
    const id = merged.assignee?.accountId ?? "__unassigned__";
    let a = accs.get(id);
    if (!a) {
      a = {
        accountId: merged.assignee?.accountId ?? null,
        displayName: assigneeName(merged),
        committed: 0,
        done: 0,
        doneByStatus: new Map(),
        transitions: new Map(),
        noProgress: [],
      };
      accs.set(id, a);
    }
    a.committed++;

    const ref: IssueRef = { key: f.key, summary: merged.summary };
    if (isDone(merged.statusCategory)) {
      completed++;
      a.done++;
      const arr = a.doneByStatus.get(merged.statusName) ?? [];
      arr.push(ref);
      a.doneByStatus.set(merged.statusName, arr);
    } else {
      if (merged.statusName !== f.statusName) {
        const key = `${f.statusName} -> ${merged.statusName}`;
        const bucket = a.transitions.get(key) ?? { from: f.statusName, to: merged.statusName, issues: [] };
        bucket.issues.push(ref);
        a.transitions.set(key, bucket);
      } else {
        a.noProgress.push({ status: merged.statusName, key: f.key, summary: merged.summary });
      }
      if (merged.sprintCount >= 2) {
        stuck.push({
          key: f.key,
          summary: merged.summary,
          displayName: assigneeName(merged),
          statusName: merged.statusName,
          sprintCount: merged.sprintCount,
        });
      }
    }
  }

  const assignees: AssigneeCompletion[] = [...accs.values()]
    .map((a) => ({
      accountId: a.accountId,
      displayName: a.displayName,
      committed: a.committed,
      done: a.done,
      rate: a.committed === 0 ? 0 : Math.round((a.done / a.committed) * 100),
      doneByStatus: [...a.doneByStatus.entries()]
        .sort(([s1], [s2]) => (s1 === "Done" ? -1 : s2 === "Done" ? 1 : s1.localeCompare(s2)))
        .map(([status, issues]) => ({ status, issues })),
      transitions: [...a.transitions.values()].sort((x, y) =>
        `${x.from} -> ${x.to}`.localeCompare(`${y.from} -> ${y.to}`),
      ),
      noProgress: a.noProgress,
    }))
    .sort((x, y) => {
      if (x.accountId === null) return 1;
      if (y.accountId === null) return -1;
      return x.displayName.localeCompare(y.displayName);
    });

  const rate = committed === 0 ? 0 : Math.round((completed / committed) * 100);
  return { committed, completed, rate, assignees, stuck };
}
```

Behavior note vs today: the old code took `sprintCount` from live with frozen fallback (`current?.sprintCount ?? f.sprintCount`) — `merged.sprintCount` is the same value. Same for status category.

Minimal compile fix in `formatCompletedMessage` (fully rewritten in Task 2 — here only make it compile and keep the old tests passing): replace `result.byAssignee` with `result.assignees.filter((a) => a.done > 0)` and render each done issue from `doneByStatus`:

```ts
  if (result.assignees.every((a) => a.done === 0)) {
    lines.push("");
    lines.push("_Жодної задачі не завершено._");
  }
  for (const group of result.assignees.filter((a) => a.done > 0)) {
    lines.push("");
    lines.push(`*${assigneeLabel(group)}*`);
    for (const bucket of group.doneByStatus) {
      for (const issue of bucket.issues) {
        lines.push(`  • ${issue.key} — ${issue.summary}`);
      }
    }
  }
```

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run lib/sprintReport.test.ts`
Expected: PASS (all). Then `npm test` — expect the web page `app/(dashboard)/sprint/page.tsx` is NOT type-checked by vitest, so no other failures; if `npm run lint` or other suites reference `byAssignee`, they're handled in Task 3.

- [ ] **Step 5: Commit**

```bash
git add lib/sprintReport.ts lib/sprintReport.test.ts
git commit -m "feat(sprint): classify completion per assignee — done-by-status, transitions, no-progress, per-person rates"
```

---

### Task 2: Slack message formatters — v2 completed layout + `Name (<@ID>)` labels

**Files:**
- Modify: `lib/sprintReport.ts` (`assigneeLabel`, `formatCompletedMessage`)
- Test: `lib/sprintReport.test.ts`

**Interfaces:**
- Consumes: `CompletionResult`/`AssigneeCompletion`/`StuckIssue` from Task 1; existing `mention(person)` (`lib/mention.ts`) and `personForJiraAccountId` (`lib/people.ts`).
- Produces: final message text consumed verbatim by `lib/runSprint.ts` (no changes needed there) — both the Monday committed and Sunday completed posts now label assignees `Display Name (<@SLACKID>)`.

- [ ] **Step 1: Write the failing tests**

Update the existing committed-message mention test and the `formatCompletedMessage` describe block in `lib/sprintReport.test.ts`:

Replace the assertion in `"mentions a known assignee in the committed message"`:

```ts
    const msg = formatCommittedMessage(snapshot);
    const p = personForJiraAccountId(acc)!;
    expect(msg).toContain(`*Volodymyr Pavliukevych (${mention(p)})*`);
```

Replace the whole `formatCompletedMessage` describe with:

```ts
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
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run lib/sprintReport.test.ts`
Expected: FAIL — old label/layout (`*<@…>*` without display name, no bucket headers, old stuck format).

- [ ] **Step 3: Implement**

In `lib/sprintReport.ts`:

`assigneeLabel` — display name + parenthesized mention when the person has a slackId:

```ts
/** Slack label for an assignee: "Display Name (<@SLACKID>)" when the Jira
 *  accountId maps to a person with a slackId, else the plain display name. */
function assigneeLabel(group: { accountId: string | null; displayName: string }): string {
  const p = group.accountId ? personForJiraAccountId(group.accountId) : undefined;
  return p?.slackId ? `${group.displayName} (${mention(p)})` : group.displayName;
}
```

`formatCompletedMessage` — full replacement:

```ts
/**
 * The Sunday "Completed" #general post: overall rate, then EVERY committed
 * assignee with their per-person rate and buckets (done by status name,
 * transitions since the freeze, no progress), and the stuck highlight.
 * Section headers are English Jira status names verbatim; the rest Ukrainian.
 */
export function formatCompletedMessage(sprintName: string, result: CompletionResult): string {
  const lines: string[] = [];
  lines.push(
    `✅ Спринт *${sprintName}* — виконано ${result.completed}/${result.committed} (${result.rate}%)`,
  );

  if (result.completed === 0) {
    lines.push("");
    lines.push("_Жодної задачі не завершено._");
  }

  for (const a of result.assignees) {
    lines.push("");
    lines.push(`*${assigneeLabel(a)}* — ${a.done}/${a.committed} (${a.rate}%)`);
    for (const bucket of a.doneByStatus) {
      lines.push(`  ${bucket.status}:`);
      for (const i of bucket.issues) lines.push(`    • ${i.key} — ${i.summary}`);
    }
    for (const t of a.transitions) {
      lines.push(`  ${t.from} -> ${t.to}:`);
      for (const i of t.issues) lines.push(`    • ${i.key} — ${i.summary}`);
    }
    if (a.noProgress.length > 0) {
      lines.push("  No progress:");
      for (const i of a.noProgress) lines.push(`    • ${i.status} - ${i.key} — ${i.summary}`);
    }
  }

  if (result.stuck.length > 0) {
    lines.push("");
    lines.push("⚠️ Зависли (кілька спринтів):");
    for (const s of result.stuck) {
      lines.push(
        `  • ${s.statusName} - ${s.displayName} - ${s.key} — ${s.summary} (${pluralizeSprints(s.sprintCount)})`,
      );
    }
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run the full test file**

Run: `npx vitest run lib/sprintReport.test.ts`
Expected: PASS. Note the FIRST completed-message test from Task 1's era (`renders a Ukrainian completed message…`) was replaced in Step 1; no test should reference the old flat done list.

- [ ] **Step 5: Commit**

```bash
git add lib/sprintReport.ts lib/sprintReport.test.ts
git commit -m "feat(sprint): completed-report v2 message — status buckets, transitions, per-person rates, Name (<@id>) labels"
```

---

### Task 3: Web tab — render v2 completed result with legacy fallback

**Files:**
- Modify: `app/(dashboard)/sprint/page.tsx`

**Interfaces:**
- Consumes: `SprintRecord` JSON from `GET /api/sprint?slug=…` — `completed.result` is either v2 (`assignees` present, `stuck[].statusName` present) or legacy (`byAssignee`, no `statusName`). Types duplicated locally in the page (existing pattern — the page declares its own interfaces).
- Produces: nothing downstream.

- [ ] **Step 1: Update the page's local types**

In `app/(dashboard)/sprint/page.tsx`, extend the completed-result interfaces (keep `AssigneeGroup` — both the legacy fallback and `groupCommitted` use it):

```ts
interface IssueRef { key: string; summary: string }
interface AssigneeCompletion {
  accountId: string | null;
  displayName: string;
  committed: number;
  done: number;
  rate: number;
  doneByStatus: { status: string; issues: IssueRef[] }[];
  transitions: { from: string; to: string; issues: IssueRef[] }[];
  noProgress: { status: string; key: string; summary: string }[];
}
interface StuckIssue { key: string; summary: string; displayName: string; statusName?: string; sprintCount: number }
interface CompletionResult {
  committed: number;
  completed: number;
  rate: number;
  /** v2 records */
  assignees?: AssigneeCompletion[];
  /** legacy records (pre-v2) */
  byAssignee?: AssigneeGroup[];
  stuck: StuckIssue[];
}
```

- [ ] **Step 2: Render the v2 per-person completion section**

Insert a new section between the stuck section and the «Взято в роботу» section, rendered only when `completed?.assignees` is present (legacy records show exactly today's UI — header rate + stuck + committed list):

```tsx
          {completed?.assignees && (
            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-slate-700">Виконання (за виконавцем)</h3>
              {completed.assignees.map((a) => (
                <div key={a.accountId ?? "__unassigned__"} className="rounded-md border border-slate-200 p-3">
                  <div className="mb-1 font-medium">
                    {a.displayName}
                    <span className="ml-2 text-sm text-slate-600">— {a.done}/{a.committed} ({a.rate}%)</span>
                  </div>
                  <ul className="space-y-0.5 text-sm">
                    {a.doneByStatus.map((b) =>
                      b.issues.map((i) => (
                        <li key={i.key} className="flex items-baseline gap-2">
                          <span className="rounded bg-green-100 px-1 text-xs text-green-800">{b.status}</span>
                          <span className="font-mono text-xs">{i.key}</span>
                          <span>{i.summary}</span>
                        </li>
                      )),
                    )}
                    {a.transitions.map((t) =>
                      t.issues.map((i) => (
                        <li key={i.key} className="flex items-baseline gap-2">
                          <span className="rounded bg-blue-100 px-1 text-xs text-blue-800">{t.from} → {t.to}</span>
                          <span className="font-mono text-xs">{i.key}</span>
                          <span>{i.summary}</span>
                        </li>
                      )),
                    )}
                    {a.noProgress.map((i) => (
                      <li key={i.key} className="flex items-baseline gap-2">
                        <span className="rounded bg-slate-100 px-1 text-xs text-slate-600">{i.status}</span>
                        <span className="font-mono text-xs">{i.key}</span>
                        <span>{i.summary}</span>
                        <span className="text-xs text-slate-400">· без прогресу</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          )}
```

- [ ] **Step 3: Show the stuck status when present**

In the existing stuck `<li>`, prepend the status chip when `s.statusName` exists (legacy records lack it):

```tsx
                {completed.stuck.map((s) => (
                  <li key={s.key}>
                    {s.statusName && (
                      <span className="mr-1 rounded bg-amber-100 px-1 text-xs">{s.statusName}</span>
                    )}
                    <span className="font-mono">{s.key}</span> — {s.summary}{" "}
                    <span className="text-amber-700">({s.sprintCount} спринтів · {s.displayName})</span>
                  </li>
                ))}
```

- [ ] **Step 4: Verify — lint, tests, build**

Run: `npm run lint && npm test && npm run build`
Expected: all pass. The build type-checks the page against its local interfaces (legacy `byAssignee` optional, so no `assignees`-missing errors).

- [ ] **Step 5: Manual smoke (optional but cheap)**

Run: `npm run sprint -- report` (DRY-RUN, prints the v2 message without posting) — eyeball the layout against the spec example.

- [ ] **Step 6: Commit**

```bash
git add "app/(dashboard)/sprint/page.tsx"
git commit -m "feat(sprint): web tab renders v2 completion — per-person buckets + rates, stuck status; legacy records unchanged"
```
