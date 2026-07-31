# Sprint completion report v2 — per-status buckets, transitions, per-person rates

**Date:** 2026-07-31
**Status:** Approved

## Problem

The Sunday sprint completion report (`formatCompletedMessage` in `lib/sprintReport.ts`)
lists only the DONE issues per assignee. It hides what happened to the other ~75% of
the committed baseline: which issues moved (status transitions since the Monday
freeze), which sat untouched, and how each person did individually. The stuck list
shows no status/assignee, and assignee names are Slack-mentioned without the readable
display name.

## Decisions (user-confirmed)

1. **Rate metric unchanged.** Any live status in Jira's Done CATEGORY (including
   CANCELLED) counts as виконано. The display splits done-category issues by literal
   status name; the numerator/denominator do not change.
2. **Stuck lines keep the issue key**: `• {status} - {assignee} - {key} — {summary}
   (N спринтів)`.
3. **English section headers** (Done:, CANCELLED:, `QA Blocked -> Review:`,
   `No progress:`) — they mirror Jira status names verbatim; the surrounding message
   stays Ukrainian.
4. **Per-person rate** on each assignee header: `*Name (<@ID>)* — 3/9 (33%)` (done
   count / that person's committed count).

## Design

### Classification (pure, `lib/sprintReport.ts`)

`computeCompletion(frozen, live)` classifies **every** frozen issue per assignee.
The frozen snapshot already stores each issue's Monday `statusName`; live re-fetch
gives the current one. A frozen key absent from `live` falls back to its frozen
fields (counts as not done, no transition), as today.

Per issue:

- Live status category **Done** → the assignee's **done bucket**, grouped by live
  `statusName` ("Done", "CANCELLED", …). All done-category issues count toward the
  rate (unchanged metric).
- Not done and frozen `statusName` ≠ live `statusName` → a **transition bucket**
  keyed `{from} -> {to}` (statusName strings verbatim).
- Not done and status unchanged → **no progress**, carrying the current status.

### New result shape

```ts
interface IssueRef { key: string; summary: string }

interface AssigneeCompletion {
  accountId: string | null;
  displayName: string;
  committed: number;               // frozen issues assigned to this person
  done: number;                    // done-category count
  rate: number;                    // whole percent, 0 when committed === 0
  doneByStatus: { status: string; issues: IssueRef[] }[];
  transitions: { from: string; to: string; issues: IssueRef[] }[];
  noProgress: { status: string; key: string; summary: string }[];
}

interface CompletionResult {
  committed: number;
  completed: number;
  rate: number;
  assignees: AssigneeCompletion[]; // replaces byAssignee; every committed assignee
  stuck: StuckIssue[];             // gains statusName; keeps key
}
```

`StuckIssue` gains `statusName` (the live status). Assignee ordering: by display
name, unassigned («Не призначено») last — same rule as `groupByAssignee`.
Bucket ordering inside an assignee: done statuses ("Done" first, the rest
alphabetical), then transitions (alphabetical by `{from} -> {to}`), then no
progress. Deterministic for stable message/render output.

The assignee attributed to an issue is the **live** assignee (fallback frozen),
matching today's merge rule.

### Legacy stored records

`SprintRecord.completed.result` rows already in the DB keep the old shape
(`byAssignee`, no `statusName` on stuck). Nothing migrates them. The web tab
renders the new layout when `assignees` is present and falls back to the old
done-only render otherwise. New Sunday runs (and manual `npm run sprint report`)
store v2.

### Slack message (`formatCompletedMessage`)

```
✅ Спринт *ATP 43* — виконано 13/54 (24%)

*Volodymyr Pavliukevych (<@U…>)* — 4/9 (44%)
  Done:
    • ATP-1702 — Гіпотеза 2 — Натренувати модель…
  CANCELLED:
    • ATP-1619 — …
  QA Blocked -> Review:
    • ATP-1718 — Після виходу з круїзу…
  No progress:
    • To Do - ATP-1807 — Проаналізувати трекери…

⚠️ Зависли (кілька спринтів):
  • To Do - Danylo Tomashy - ATP-1749 — Дрон завжди рестартує… (3 спринти)
```

- The `_Жодної задачі не завершено._` line stays for a zero-done sprint, followed
  by the per-assignee blocks (they still show transitions/no-progress).
- Assignee label: `Name (<@SLACK_ID>)` when the Jira accountId maps to a
  `lib/people.ts` person with a slackId, else the plain display name. This changes
  `assigneeLabel` and therefore applies to **both** the Monday committed message and
  the Sunday completed message.

### Web tab (`app/(dashboard)/sprint/page.tsx`)

The completed state renders per-person cards with the per-person rate and the three
bucket groups (done-by-status, transitions as `from -> to` labels, no progress with
status chips). Stuck section shows status + assignee + key + summary + sprint count.
Legacy records (no `assignees`) render exactly as today. Plain names on the web —
no Slack mention markup (per `lib/mention.ts` discipline).

### Untouched

Commit flow (`formatCommittedMessage` layout, freeze semantics), the completion
metric, store keys/idempotency, crons, CLI surface (`npm run sprint report` already
prints the message text). No new env.

## Testing

`lib/sprintReport.test.ts`:

- Classification: done split by status name; transition detected (frozen ≠ live
  status, not done); no-progress; missing-from-live falls back to frozen (no
  transition, not done).
- Per-person committed/done/rate; assignee + bucket ordering; unassigned last.
- Rate metric unchanged incl. CANCELLED-counts-as-done.
- Stuck entries carry statusName + key.
- Message snapshot: header rate, per-person header `Name (<@ID>) — n/m (p%)`,
  English bucket headers, `No progress:` line format `• {status} - {key} — {summary}`,
  stuck line format, zero-done message.
- `assigneeLabel` with/without slackId (via the committed + completed formatters).
