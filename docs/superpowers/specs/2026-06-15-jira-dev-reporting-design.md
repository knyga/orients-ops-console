# Jira Dev Reporting — Design

**Date:** 2026-06-15
**Status:** Approved, ready for implementation planning

## Goal

Give the ops console read-only access to Jira Cloud so the **Dev Reporting**
tab can show, for a user-selected date range:

1. **Per-user resolved stats** — for each assignee, the count of issues resolved
   in the range and the sum of their story points.
2. **Period totals** — grand total resolved count and story points across all
   users in the range.
3. **Sprint churn** — issues that changed sprints during the range: issue key,
   title, and each sprint→sprint move.

The token must never reach the browser, mirroring the existing Vimeo
integration (`lib/vimeo.ts` + `app/api/vimeo/route.ts`).

## Decisions (locked)

- **Deployment / auth:** Jira Cloud, HTTP Basic auth using an Atlassian API
  token. `Authorization: Basic base64(email:token)`.
- **Scope:** several fixed projects, configured via env (comma-separated keys).
- **Period model:** user picks a `start`/`end` date range. "Total resolved" =
  the period grand total (no all-time query).
- **"Resolved":** issues whose `resolutiondate` falls inside the range
  (standard JQL `resolved >= start AND resolved <= end`).
- **Story points:** per-instance custom field, auto-detected by field name
  ("Story Points" / "Story point estimate") via `GET /rest/api/3/field`, with
  `JIRA_STORY_POINTS_FIELD` env override. Summed as-is per resolved issue, no
  parent/sub-task roll-up. Missing/null → 0.
- **Unassigned issues:** bucketed under a single "Unassigned" row.
- **Computation:** done server-side; the API route returns finished stats
  (Approach A). No raw changelog payloads shipped to the browser.

## Configuration

New `.env` / `.env.example` vars, read **only** on the server:

```
JIRA_BASE_URL=https://your-org.atlassian.net
JIRA_EMAIL=service-account@your-org.com
JIRA_API_TOKEN=...                       # Atlassian API token, read access
JIRA_PROJECT_KEYS=DEV,OPS                # comma-separated, fixed scope
JIRA_STORY_POINTS_FIELD=customfield_...  # optional; auto-detected if unset
```

## Components

### `lib/jira.ts` — server-only typed client

- `import "server-only"` at the top (an accidental client import becomes a
  build error), exactly like `lib/vimeo.ts`.
- Reads env; builds the Basic auth header from `JIRA_EMAIL` + `JIRA_API_TOKEN`.
- `JiraError extends Error` with an optional `status` — same shape as
  `VimeoError`.
- `resolveStoryPointsField(): Promise<string>` — if `JIRA_STORY_POINTS_FIELD`
  is set, returns it. Otherwise one `GET /rest/api/3/field` call, finds the
  field whose name matches "Story Points" / "Story point estimate"
  (case-insensitive), returns its `id`. Result cached in-module per process.
  Throws `JiraError` (no status → 500) if none found.
- `fetchResolvedIssues(start, end): Promise<JiraIssue[]>`:
  - Validates `start`/`end` are `YYYY-MM-DD` (throws `JiraError` otherwise).
  - POSTs `/rest/api/3/search` with:
    - JQL: `project in (<keys>) AND resolved >= "<start>" AND resolved <= "<end>" ORDER BY resolved ASC`
    - `expand: ["changelog"]`
    - `fields: ["summary", "assignee", "resolutiondate", "status", <story-points field>]`
    - `maxResults: 100`, paging via `startAt` until `startAt + maxResults >= total`.
  - All fetches use `cache: "no-store"` so stats reflect live Jira.
  - Maps non-2xx to `JiraError` with `res.status`, message truncated (~300
    chars) like the Vimeo client.
  - Returns typed `JiraIssue[]` carrying: `key`, `summary`, `assignee`
    (`{ accountId, displayName } | null`), `resolutiondate`, story-point value,
    and `changelog.histories`.

**Pagination note on changelog:** `/rest/api/3/search?expand=changelog`
returns up to the most recent 100 history entries per issue inline. For the
expected volume (sprint moves on dev issues) this is sufficient; if an issue
exceeds 100 history entries the older ones are not fetched. This limit is
accepted for v1 and noted here rather than silently assumed.

### `lib/jiraStats.ts` — pure aggregation (unit-tested)

No React/Next imports — same discipline as `lib/reconcile.ts`.

- `aggregateByUser(issues): { rows: UserRow[]; totals: PeriodTotals }`
  - `UserRow = { accountId: string | null; displayName: string; resolvedCount: number; storyPoints: number }`
  - Issues with no assignee → `displayName: "Unassigned"`, `accountId: null`.
  - `storyPoints` sums the story-point field per issue, treating null/undefined
    as 0.
  - `PeriodTotals = { totalResolved: number; totalStoryPoints: number }`.
  - Rows sorted by `resolvedCount` desc (tie-break by displayName) for stable
    rendering.
- `sprintChurn(issues): SprintChurnRow[]`
  - `SprintChurnRow = { issueKey: string; summary: string; changes: SprintChange[] }`
  - `SprintChange = { from: string; to: string; when: string }`
  - For each issue, scans `changelog.histories[].items` for items where
    `field === "Sprint"`. Each such item's `fromString`/`toString` are
    comma-separated sprint names; the change records the move
    (`from` → `to`) with the history `created` timestamp as `when`.
  - Issues with zero sprint-change items are omitted from the result.

### `app/api/jira/route.ts`

- `GET /api/jira?start=YYYY-MM-DD&end=YYYY-MM-DD`.
- `runtime = "nodejs"`, `dynamic = "force-dynamic"`.
- Same validation as the Vimeo route: both params required (400), each must be
  `YYYY-MM-DD` (400), `start <= end` (400).
- Resolves the story-points field, calls `fetchResolvedIssues`, runs
  `aggregateByUser` + `sprintChurn`, returns
  `{ rows, totals, sprintChurn }` as JSON.
- Catch: `JiraError` → 502 if it has a status (upstream), else 500 (config);
  other errors → 500. Mirrors the Vimeo route exactly.

### `app/(dashboard)/dev-reporting/page.tsx`

Replaces the "Coming soon" stub. Client component:

- Date-range inputs (`start`/`end`), defaulting to a sensible recent range.
- Fetches `/api/jira?start=&end=` into state; loading + error states styled
  like Field Ops.
- Renders two sections:
  1. **Per-user table:** columns user · resolved · story points, with a final
     period-total row.
  2. **Sprint churn list:** each entry shows issue key + title and its sprint
     moves (`from → to`).

### `app/(dashboard)/layout.tsx`

Flip the Dev Reporting tab to `enabled: true`.

## Data flow

Browser (date range) → `GET /api/jira` → `lib/jira.ts` (Basic auth, paged
search with `expand=changelog`) → `lib/jiraStats.ts` (pure aggregation) → JSON
`{ rows, totals, sprintChurn }` → page renders. Token stays server-side;
`cache: "no-store"` keeps stats live.

## Error handling

- Missing/invalid config (no token, story-points field not found) → `JiraError`
  without status → HTTP 500.
- Jira non-2xx (auth failure, rate limit, bad JQL) → `JiraError` with status →
  HTTP 502, message truncated.
- The page surfaces the returned error string.

## Testing

`lib/jiraStats.test.ts` (Vitest), covering:

- Per-user resolved-count and story-point summing across multiple issues.
- Story-point null/undefined treated as 0.
- Period grand totals (count + story points).
- Assignee-less issues bucketed as "Unassigned".
- `sprintChurn`: issue with no Sprint changelog item → omitted; issue with one
  move → single change; issue with multiple moves → all changes, in order.

`lib/jira.ts` stays thin (I/O only) and untested, consistent with how
`lib/vimeo.ts` is untested while `lib/reconcile.ts` carries the tests.

## Out of scope (v1)

- OAuth / multi-user auth (using a single service-account API token).
- User-selectable projects or boards (fixed env scope).
- Weekly/sprint bucketing within the range (single range only).
- Changelog history beyond the most recent 100 entries per issue.
- Persisting any Jira data (all reads are live).
