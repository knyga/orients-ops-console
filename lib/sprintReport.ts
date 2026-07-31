/**
 * Pure sprint-completion logic. No React/Next/node imports — unit-tested, same
 * discipline as lib/reconcile.ts and lib/jiraStats.ts.
 *
 * Domain (see docs/superpowers/specs/2026-07-19-sprint-completion-design.md):
 *  - Weekly sprint on the Autopilot board. The COMMITTED baseline is the exact
 *    set of issues in the active sprint at the Monday-~21:00-Kyiv snapshot; it is
 *    frozen to an artifact and never recomputed.
 *  - COMPLETION is issue-count based: a frozen issue is done when its status is in
 *    the `Done` status CATEGORY (any terminal/green status), not the literal name.
 *  - STUCK across sprints: a frozen issue that is NOT done and has lived in >= 2
 *    sprints (carried over from >= 1 prior sprint). A first-attempt issue (sprint
 *    count 1) is never flagged.
 *
 * lib/jira.ts maps Jira's REST response into SprintIssue; everything here depends
 * only on that shape.
 */

import { mention } from "./mention";
import { personForJiraAccountId } from "./people";

export interface SprintIssue {
  key: string;
  summary: string;
  assignee: { accountId: string; displayName: string } | null;
  /** Human status name, e.g. "In Progress". */
  statusName: string;
  /** Status CATEGORY name, e.g. "Done" | "In Progress" | "To Do". */
  statusCategory: string;
  /** Distinct sprints this issue has ever belonged to (>= 1). */
  sprintCount: number;
}

export interface SprintSnapshot {
  sprintId: number;
  sprintName: string;
  slug: string;
  /** ISO timestamp the baseline was frozen. */
  capturedAt: string;
  issues: SprintIssue[];
}

export interface AssigneeGroup {
  accountId: string | null;
  displayName: string;
  issues: SprintIssue[];
}

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

const UNASSIGNED_LABEL = "Не призначено";

/** Sprint name → filesystem/URL-safe slug: "ATP 42" → "ATP-42". */
export function slugifySprint(name: string): string {
  return name
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/** True when a status CATEGORY is the terminal "Done" (green) category. */
export function isDone(statusCategory: string): boolean {
  return statusCategory.trim().toLowerCase() === "done";
}

/** Ukrainian plural for a sprint count: "2 спринти", "5 спринтів". */
export function pluralizeSprints(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  let word: string;
  if (mod10 === 1 && mod100 !== 11) word = "спринт";
  else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) word = "спринти";
  else word = "спринтів";
  return `${n} ${word}`;
}

/** Stable assignee display name (unassigned → the Ukrainian label). */
function assigneeName(issue: SprintIssue): string {
  return issue.assignee?.displayName ?? UNASSIGNED_LABEL;
}

/** Bold Slack label for an assignee group: a mention when the Jira accountId
 *  maps to a person with a slackId, else the plain display name. */
function assigneeLabel(group: { accountId: string | null; displayName: string }): string {
  const p = group.accountId ? personForJiraAccountId(group.accountId) : undefined;
  return p ? mention(p) : group.displayName;
}

/**
 * Group issues by assignee. Assignees are sorted by name; the unassigned bucket
 * is always ordered last. Deterministic for stable message/render output.
 */
export function groupByAssignee(issues: SprintIssue[]): AssigneeGroup[] {
  const groups = new Map<string, AssigneeGroup>();
  for (const issue of issues) {
    const id = issue.assignee?.accountId ?? "__unassigned__";
    let g = groups.get(id);
    if (!g) {
      g = { accountId: issue.assignee?.accountId ?? null, displayName: assigneeName(issue), issues: [] };
      groups.set(id, g);
    }
    g.issues.push(issue);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.accountId === null) return 1;
    if (b.accountId === null) return -1;
    return a.displayName.localeCompare(b.displayName);
  });
}

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

/**
 * The Monday "Committed" #general post: grouped by assignee, then by status.
 * Jira keys + summaries verbatim; labels Ukrainian.
 */
export function formatCommittedMessage(snapshot: SprintSnapshot): string {
  const lines: string[] = [];
  lines.push(`📋 Спринт *${snapshot.sprintName}* — взято в роботу: ${snapshot.issues.length} задач`);

  for (const group of groupByAssignee(snapshot.issues)) {
    lines.push("");
    lines.push(`*${assigneeLabel(group)}*`);
    // Within an assignee, order by status name for a stable, readable grouping.
    const byStatus = new Map<string, SprintIssue[]>();
    for (const issue of group.issues) {
      const arr = byStatus.get(issue.statusName) ?? [];
      arr.push(issue);
      byStatus.set(issue.statusName, arr);
    }
    for (const status of [...byStatus.keys()].sort((a, b) => a.localeCompare(b))) {
      lines.push(`  ${status}:`);
      for (const issue of byStatus.get(status)!) {
        lines.push(`    • ${issue.key} — ${issue.summary}`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * The Sunday "Completed" #general post: overall rate, done issues grouped by
 * assignee, and a stuck-across-sprints highlight.
 */
export function formatCompletedMessage(sprintName: string, result: CompletionResult): string {
  const lines: string[] = [];
  lines.push(
    `✅ Спринт *${sprintName}* — виконано ${result.completed}/${result.committed} (${result.rate}%)`,
  );

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

  if (result.stuck.length > 0) {
    lines.push("");
    lines.push("⚠️ Зависли (кілька спринтів):");
    for (const s of result.stuck) {
      lines.push(`  • ${s.key} — ${s.summary} (${pluralizeSprints(s.sprintCount)})`);
    }
  }
  return lines.join("\n");
}
