# Known gaps & limitations

Living record of known gaps in the **artifact-driven reporting** system
(`skill → CLI --write → committed reports/<feature>/<period>.{json,csv} → web
renders, hybrid live Refresh`). Each entry notes whether it's **by design** (an
accepted trade-off) or **debt** (worth fixing), plus impact. Last updated for the
`feat/artifact-driven-reports` work (2026-06-16).

## Build & deploy

- **Turbopack NFT file-trace warning** (debt, low). `next build` emits one warning:
  `lib/reports.ts` does runtime `readFileSync`/`readdirSync` with a dynamic
  `feature`/`period`, so Node File Tracing over-traces the project. Build
  succeeds and runtime reads work (verified). Only matters for `output:
  "standalone"` bundle size. Fix options: scope reads more statically, or accept
  it. Not chased to avoid `turbopackIgnore` comments that could drop the
  `reports/` data from a standalone trace.
- **No CI / automated route tests** (debt, medium). The hybrid API routes
  (`?period`/`?periods`/`?refresh`, 404/400) and the React pages/hook
  (`usePeriodReport`) were verified manually via `curl` + dev server, not by
  automated tests. Only the pure `lib/`/`scripts/` modules have Vitest coverage.

## Artifact model

- **CSV is intentionally lossy** (by design). The committed `.csv` is a flat
  human/spreadsheet record; nested data lives only in the `.json` (the lossless
  render source): Jira sprint churn, GitHub repo ranking + per-PR detail, Vimeo
  per-video list. Never render the CSV as if complete.
- **`periodKey` collapses partial months** (by design). Any window inside one
  calendar month → `YYYY-MM`; `parsePeriodKey("YYYY-MM")` expands to the full
  month (1st…last). So a partial-month `--start/--end` is keyed/labelled as the
  whole month. Cross-month windows keep both bounds.
- **`reports/` grows unbounded** (debt, low). Committed artifacts accumulate
  month over month with no pruning/retention policy. Fine for now; revisit if the
  repo bloats.

## Jira

- **Backfilled JSON is degraded** (by design, documented). The 7 historical
  months (`reports/jira/*.json`) were converted from the committed CSVs, which
  never stored `accountId` or sprint churn. So in backfilled months:
  `sprintChurn` is `[]`, and each row's `accountId` is **synthesised from the
  display name** (summaries keyed the same way). Counts/points/issues/summaries
  are faithful. Months written fresh by the CLI (live Jira) carry real accountIds
  + sprint churn.
- **`lib/summarize.ts` (opus `--summarize`) path is untested live** (debt, low).
  The committed summaries were produced via the **sonnet-subagent** flow
  (`--dump-tickets` → subagent → `--summaries-file`), not the CLI's built-in
  opus `--summarize`. That opus path compiles and is wired but hasn't been run
  end-to-end here.

## GitHub

- **Contributor key collisions theoretically possible** (by design, negligible).
  Work/summaries key contributors by `login:<login>` or, for unlinked commits,
  `name:<authorName>`. A login that exactly matches an unlinked author name would
  collide — not observed; GitHub logins are unique.
- **Bots get no occupation summary** (by design). `workByContributor` skips bots;
  they still appear in the leaderboard/CSV, just without a Summary.
- **All-zeros = token scope, not empty period** (by design, guarded). If
  `GH_ACCESS_TOKEN` lacks repo/org read scope the CLI returns repos but zero
  commits/PRs; the CLI prints a stderr warning and the skill documents it. (The
  token in use here *does* have scope and returns real data — the prior
  `github-activity-token-scope` memory was about a narrower token.)
- **Live mode has no Summary column** (by design). Summaries live in committed
  artifacts; a live Refresh of the current month returns raw activity with no
  summaries (the column simply doesn't render).

## Field Ops

- **Committed current-month reports are provisional** (by design, documented).
  Videos group by Kyiv **upload date** and can lag a working day, so a
  just-closed/current month may need re-running after late uploads land. The page
  notes this.
- **Flight hours require a manual commit step** (by design). To make a month a
  committed source of record, hours must be written to
  `reports/field-ops/inputs/<period>.csv` and `npm run fieldops -- --write` run.
  The web's paste editor stays **ephemeral/unsaved** (the web never writes the
  repo).
- **`/api/field-ops` has no live mode** (by design). Live reconciliation needs
  the ephemeral paste, which is a pure client computation against
  `/api/vimeo?refresh=1`. The route is committed-read only.
- **Committed field-ops artifact omits raw videos** (by design). It stores
  `daily`/`summary`/`flightInputPath` only, so the committed view shows the
  reconciliation table + summary but **not** the per-video table (that appears in
  live mode only).
- **Invalid committed flight-hours lines are silently dropped** (debt, low).
  `parseFlightHoursCsv`/`toFlightDays` skip malformed/≤0 rows (ephemeral-input
  tolerance). A typo in a committed inputs CSV is dropped without CLI feedback —
  no validation/strict mode.
- **No `--summarize`/subagent flow for field-ops** (by design). Reconciliation is
  numeric; there's no per-person prose to summarise.

## Vimeo

- **Committed `VimeoStats` can't drive reconciliation** (by design). Its
  `videos[]` is shaped/rounded (no raw `created_time`/`duration` seconds), so
  field-ops fetches Vimeo live rather than reading the vimeo artifact. The two
  features are intentionally separate (`reports/vimeo/` vs `reports/field-ops/`).

## Conventions / misc

- **server-only libs are untested** (by design, per repo convention). `lib/jira`,
  `lib/github`, `lib/vimeo`, `lib/summarize`, `lib/githubClient`, and the
  fetchers are network/env-bound; covered only by manual CLI runs. Pure logic is
  where the unit tests live.
- **Dev server runs on port 3003** (info), not the commonly-assumed 3000
  (`next dev -p 3003`).
- **Repo is local-only** (info). `origin/main` is gone; nothing is pushed. Merges
  are local fast-forwards.
