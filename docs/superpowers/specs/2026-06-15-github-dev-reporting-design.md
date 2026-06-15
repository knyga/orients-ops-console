# GitHub Dev Reporting — Design

**Date:** 2026-06-15
**Status:** Approved (pending spec review)
**Module slot:** the existing disabled `Dev Reporting` dashboard tab.

## Goal

Report engineering activity across the `orients-ai` GitHub org for a chosen
date range, answering:

- Who committed how many commits?
- Who opened how many PRs, and how many landed (merged)?
- How much code landed on the default branch (additions, deletions, net)?
- Which repositories were most active?

The feature ships **two interfaces over one shared code path** (per CLAUDE.md):
a web page in the dashboard and a CLI script. Both consume the same pure `lib/`
logic.

## Scope decisions (confirmed)

- **Repos:** all *active* repos the token can see — public **and** private,
  **excluding** archived repos and forks. New repos are auto-included (no
  allowlist).
- **PRs:** report *opened* and *merged* as separate metrics. "Opened" = PR
  `createdAt` within the period; "merged" = PR `mergedAt` within the period.
- **Code volume:** report all of additions, deletions, **net** (added −
  deleted), and commit count — per user and per repo, on the default branch.
- **Primary view:** a per-user **contributor leaderboard** plus a
  **most-active-repositories** ranking.
- **Bots:** dependabot/renovate and other bot accounts are **shown but
  flagged** (badge + sorted separately) so they don't distort the human
  ranking.
- **Fetch strategy:** a single server-side request fetches everything; the web
  page shows a loading state until it completes. No streaming, no persistence —
  everything is live (`cache: "no-store"`) and ephemeral, like Field Ops.

## Data source

**GitHub GraphQL API v4** (`https://api.github.com/graphql`), authenticated with
`GH_ACCESS_TOKEN`. Chosen over REST because a single history query yields
commits **with** per-commit additions/deletions **and** author login at day
precision — REST would require an N+1 GET per commit for line counts.

Per repo, two concerns are fetched:

1. **Commits on the default branch in range** —
   `repository.defaultBranchRef.target ... on Commit { history(since, until) }`,
   paginated 100/page. Each commit node provides `oid`, `committedDate`,
   `additions`, `deletions`, and `author { user { login } name }`.
2. **Pull requests** — `repository.pullRequests` (ordered by `UPDATED_AT desc`),
   paginated, taking `number`, `author { login }`, `createdAt`, `mergedAt`,
   `additions`, `deletions`. Paging stops once a page is entirely older than the
   period on both `createdAt` and `mergedAt` (it cannot contribute to either
   window). PRs are matched into the "opened" and/or "merged" buckets by date.

Repo enumeration uses `organization(login:"orients-ai").repositories` with
`isArchived`/`isFork` filtered out client-side (GraphQL exposes both fields).

### Token & scopes

`GH_ACCESS_TOKEN` needs `repo` (read) scope to include private repos, plus
`read:org`. Added to `.env.example` with this note. Missing token → the API
route returns 500 and the CLI exits non-zero with a clear message (mirrors the
Vimeo `VIMEO_TOKEN` behavior).

## Module layout

The `server-only` package **throws when imported from a plain Node process**
(its default export is a guard; only Next's `react-server` condition swaps it
for a no-op). A CLI therefore cannot import a `server-only` module. So the
fetching logic is split:

- **`lib/githubClient.ts`** — *shared; no `server-only`, no env reads.*
  Exposes `fetchOrgActivity({ token, org, start, end }): Promise<OrgActivity>`
  where `OrgActivity = { repos, commits, pullRequests }` (typed raw data, each
  commit/PR tagged with its repo). Throws `GitHubError` (with optional
  `status`). Token is **injected**, never read from env here. Consumed by both
  the server wrapper and the CLI. Uses `cache: "no-store"`.
- **`lib/github.ts`** — *thin `server-only` wrapper.* `import "server-only"`,
  reads `process.env.GH_ACCESS_TOKEN`, validates `YYYY-MM-DD` bounds, delegates
  to `githubClient`. Used **only** by the API route — preserves the
  browser-token tripwire for the web path.
- **`lib/devStats.ts`** — *pure, unit-tested* (no React/Next imports, like
  `reconcile.ts`). The aggregation policy + invariants live as a doc comment at
  the top. Exposes:
  - `buildContributorLeaderboard(activity): ContributorRow[]` — per-user totals:
    `commits`, `additions`, `deletions`, `net`, `prsOpened`, `prsMerged`,
    `isBot`. Grouped by GitHub `login`; commits with no linked user fall back to
    author `name` (flagged `unlinked`). Human rows sorted by commits desc; bot
    rows sorted after humans.
  - `buildRepoRanking(activity): RepoRow[]` — per-repo totals of the same
    metrics, sorted by a composite activity score (`commits + prsOpened +
    prsMerged`) desc.
  - `summarize(activity): DevStatsSummary` — `{ contributors, repos, totals,
    period }` convenience wrapper for both UIs.
- **`app/api/github/route.ts`** — `GET /api/github?start=&end=`. Validates
  `YYYY-MM-DD` + `start <= end` (same shape as the Vimeo route), calls
  `lib/github`, returns the raw `OrgActivity` as JSON. `GitHubError` →
  502 (upstream, has status) / 500 (config). `runtime = "nodejs"`,
  `dynamic = "force-dynamic"`.
- **`app/(dashboard)/dev-reporting/page.tsx`** — stateful client page. Date-range
  picker → fetch `/api/github` into state → recompute via `useMemo(() =>
  summarize(activity))`. Loading + error states. Renders the two tables.
- **`components/ContributorTable.tsx`** + **`components/RepoActivityTable.tsx`**
  — presentational, sortable columns, styled like the existing tables; bot rows
  carry a small "bot" badge.

### CLI

- **`scripts/dev-report.ts`** — reads `GH_ACCESS_TOKEN` from env, parses
  `--start` / `--end` (`YYYY-MM-DD`; defaults to the last 30 days ending today
  if omitted) and a `--json` flag. Calls `fetchOrgActivity` (from
  `githubClient`, **not** the `server-only` wrapper) → `summarize`. Without
  `--json`, prints the contributor leaderboard and most-active-repos ranking as
  aligned text tables to stdout; with `--json`, prints the `DevStatsSummary` as
  JSON for machine consumption. Exits non-zero on missing token / invalid args /
  API error.
- **`package.json`**: add `tsx` devDependency and
  `"dev-report": "node --env-file=.env --import tsx scripts/dev-report.ts"`.
  Invoked as `npm run dev-report -- --start=YYYY-MM-DD --end=YYYY-MM-DD`.

## Data flow

```
                 ┌──────────────────────── shared lib/ ────────────────────────┐
 web browser     │  githubClient.fetchOrgActivity  →  devStats.summarize        │
   │  GET /api/github?start&end                                                 │
   ▼             │                                                              │
 route.ts ──► github.ts (server-only, reads env) ──► githubClient ──► GitHub    │
   │                                                                            │
   └── JSON (OrgActivity) ──► page.tsx ──► useMemo(summarize) ──► tables        │
                 │                                                              │
 CLI: dev-report.ts ─ reads env ─► githubClient ──► GitHub                      │
                 │                          └─► summarize ──► stdout / --json   │
                 └──────────────────────────────────────────────────────────────┘
```

## Error handling

- Missing/empty `GH_ACCESS_TOKEN` → `GitHubError` (no status) → route 500 / CLI
  non-zero exit with a clear message.
- GraphQL transport error or `errors[]` in the response → `GitHubError` with
  status → route 502; CLI prints the upstream message and exits non-zero.
- Invalid date params → 400 (route) / usage error (CLI).
- A repo whose `defaultBranchRef` is null (empty repo) contributes zero commits,
  not an error.

## Testing

`lib/devStats.test.ts` (Vitest), against hand-built `OrgActivity` fixtures:

- commit / additions / deletions / net aggregation per user and per repo;
- PRs opened vs merged windowed independently by `createdAt` / `mergedAt`;
- commit with no linked GitHub user → falls back to author name, flagged;
- bot account → flagged and sorted after humans;
- repo ranking order by composite activity score;
- empty activity → empty leaderboards, zero totals.

`lib/githubClient.ts` and `lib/github.ts` are I/O and stay untested (like
`lib/vimeo.ts`). The pure modules hold the tested logic.

## Out of scope (YAGNI)

Persistence/history, per-repo streaming, review/comment metrics, lines-by-raw-
commit-stat reconciliation, charts, and CSV export. Can follow later if needed.
