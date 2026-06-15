/**
 * Pure aggregation for Jira Dev Reporting. No React/Next/server imports —
 * this module is unit-tested, same discipline as lib/reconcile.ts.
 *
 * It owns the canonical issue shape (JiraIssue). lib/jira.ts maps Jira's raw
 * REST response into this type; everything downstream depends only on this.
 */

/** One changelog field-change entry (we only care about `field === "Sprint"`). */
export interface JiraChangeItem {
  field: string;
  fromString: string | null;
  toString: string | null;
}

/** One changelog history group (a single edit event with a timestamp). */
export interface JiraHistory {
  /** ISO 8601 timestamp of the edit. */
  created: string;
  items: JiraChangeItem[];
}

/** A resolved Jira issue, normalized for reporting. */
export interface JiraIssue {
  key: string;
  summary: string;
  assignee: { accountId: string; displayName: string } | null;
  /** Story-point value, or null when unset. */
  storyPoints: number | null;
  /** Changelog history groups (from `expand=changelog`). */
  histories: JiraHistory[];
}

/** Per-user resolved stats over the period. */
export interface UserRow {
  /** Jira accountId, or null for the Unassigned bucket. */
  accountId: string | null;
  displayName: string;
  resolvedCount: number;
  storyPoints: number;
}

/** Period grand totals across all users. */
export interface PeriodTotals {
  totalResolved: number;
  totalStoryPoints: number;
}

const UNASSIGNED_KEY = "__unassigned__";

/**
 * Group resolved issues by assignee. Issues with no assignee land in a single
 * "Unassigned" row (accountId null). Story points null/undefined count as 0.
 * Rows are sorted by resolvedCount desc, then displayName asc, for stable
 * rendering.
 */
export function aggregateByUser(issues: JiraIssue[]): {
  rows: UserRow[];
  totals: PeriodTotals;
} {
  const byUser = new Map<string, UserRow>();

  for (const issue of issues) {
    const key = issue.assignee?.accountId ?? UNASSIGNED_KEY;
    const existing = byUser.get(key);
    const points = issue.storyPoints ?? 0;
    if (existing) {
      existing.resolvedCount += 1;
      existing.storyPoints += points;
    } else {
      byUser.set(key, {
        accountId: issue.assignee?.accountId ?? null,
        displayName: issue.assignee?.displayName ?? "Unassigned",
        resolvedCount: 1,
        storyPoints: points,
      });
    }
  }

  const rows = [...byUser.values()].sort(
    (a, b) =>
      b.resolvedCount - a.resolvedCount ||
      a.displayName.localeCompare(b.displayName),
  );

  const totals: PeriodTotals = {
    totalResolved: issues.length,
    totalStoryPoints: rows.reduce((sum, r) => sum + r.storyPoints, 0),
  };

  return { rows, totals };
}
