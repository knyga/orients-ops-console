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

/** One sprint move read from an issue's changelog. */
export interface SprintChange {
  /** Sprint(s) the issue moved from; "" when added from no sprint. */
  from: string;
  /** Sprint(s) the issue moved to; "" when removed from all sprints. */
  to: string;
  /** ISO 8601 timestamp of the move. */
  when: string;
}

/** An issue that changed sprints, with each move. */
export interface SprintChurnRow {
  issueKey: string;
  summary: string;
  changes: SprintChange[];
}

/**
 * For each issue, extract every changelog entry where the Sprint field changed,
 * ordered oldest-first by timestamp. Issues with no sprint change are omitted.
 *
 * Sprint `fromString`/`toString` are comma-separated sprint names as Jira
 * records them (e.g. "ATP 37" -> "ATP 38"); we surface them verbatim. A null
 * side (added to / removed from a sprint) is rendered as an empty string.
 */
export function sprintChurn(issues: JiraIssue[]): SprintChurnRow[] {
  const rows: SprintChurnRow[] = [];

  for (const issue of issues) {
    const changes: SprintChange[] = [];
    for (const history of issue.histories) {
      for (const item of history.items) {
        if (item.field === "Sprint") {
          changes.push({
            from: item.fromString ?? "",
            to: item.toString ?? "",
            when: history.created,
          });
        }
      }
    }
    if (changes.length > 0) {
      changes.sort((a, b) => a.when.localeCompare(b.when));
      rows.push({ issueKey: issue.key, summary: issue.summary, changes });
    }
  }

  return rows;
}
