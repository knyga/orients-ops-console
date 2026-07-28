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

export interface StuckIssue {
  key: string;
  summary: string;
  displayName: string;
  sprintCount: number;
}

export interface CompletionResult {
  committed: number;
  completed: number;
  /** Whole-percent completion rate (0 when nothing committed). */
  rate: number;
  /** Done issues grouped by assignee (unassigned last). */
  byAssignee: AssigneeGroup[];
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
 * Measure completion of a frozen baseline against a live re-fetch.
 *
 * @param frozen the committed baseline issue set (the denominator).
 * @param live   the same keys re-fetched now (status + current sprint count). A
 *               frozen key absent from `live` counts as not done.
 */
export function computeCompletion(frozen: SprintIssue[], live: SprintIssue[]): CompletionResult {
  const liveByKey = new Map(live.map((i) => [i.key, i]));
  const committed = frozen.length;

  const done: SprintIssue[] = [];
  const stuck: StuckIssue[] = [];
  for (const f of frozen) {
    const current = liveByKey.get(f.key);
    const cat = current?.statusCategory ?? f.statusCategory;
    const sprintCount = current?.sprintCount ?? f.sprintCount;
    // Prefer the live assignee/summary; fall back to the frozen snapshot.
    const merged: SprintIssue = current ?? f;
    if (isDone(cat)) {
      done.push(merged);
    } else if (sprintCount >= 2) {
      stuck.push({
        key: f.key,
        summary: merged.summary,
        displayName: assigneeName(merged),
        sprintCount,
      });
    }
  }

  const completed = done.length;
  const rate = committed === 0 ? 0 : Math.round((completed / committed) * 100);
  return { committed, completed, rate, byAssignee: groupByAssignee(done), stuck };
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

  if (result.byAssignee.length === 0) {
    lines.push("");
    lines.push("_Жодної задачі не завершено._");
  }
  for (const group of result.byAssignee) {
    lines.push("");
    lines.push(`*${assigneeLabel(group)}*`);
    for (const issue of group.issues) {
      lines.push(`  • ${issue.key} — ${issue.summary}`);
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
