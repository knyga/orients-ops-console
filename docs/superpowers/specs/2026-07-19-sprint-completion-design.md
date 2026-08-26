# Sprint Completion tracking — design

**Date:** 2026-07-19
**Status:** approved

## Problem

The team runs **weekly** sprints on the Autopilot board (Jira board 1, project ATP).
Plans for a sprint are confirmed the evening of Monday; **work in the sprint at
21:00 Kyiv on Monday is the committed baseline**. No meaningful additions happen
after Sunday. The team wants to measure and publish **sprint completion**.

Two team-facing posts to **#general**:

1. **Committed** — Monday ~21:00 Kyiv — the committed work, grouped by assignee and
   status.
2. **Completed** — Sunday ~23:59 Kyiv — the completed work, grouped by assignee,
   with an overall completion rate and a highlight of issues stuck across sprints.

**Metric:** issue **count**. **Completed** = issue's status is in the `Done`
status *category* (any terminal/green status), not the literal status name.

## Model

- **Sprint** = the single **active** sprint on board 1 (`listSprints(1,'active')`).
  Weekly. If there is no active sprint (between sprints), the job logs and skips.
- **Committed baseline** = the exact set of issues in the active sprint captured at
  the Monday job time. Sprint membership drifts through the week, so the baseline is
  **frozen to a committed artifact** at capture time (approach A) — never
  reconstructed later from changelog.
- **Completion** = (frozen issues now in `Done` category) / (frozen issue count).
- **Stuck across sprints** = a frozen issue that is **not** done and has lived in
  **≥ 2 sprints** (i.e. carried over from ≥ 1 prior sprint). Rule from the ask:
  "1 sprint not delivered → don't mention; carried from a prior sprint (1+) →
  mention", with the number of sprints it has dragged. An issue seen only in the
  current sprint (first attempt) is **not** highlighted.
  - Carry count derives from Jira's Sprint-field history per issue (the sprint
    custom field's array of sprints it has belonged to, or the Sprint changelog).

## Data flow

```
Mon  0 18 * * 1 UTC (≈21:00 Kyiv EEST / 20:00 EET)  → sprint-commit
       listSprints(1,'active') → fetchSprintIssues(sprintId)
       → freeze reports/sprint/<slug>.json
       → post "Committed" to #general (by assignee → by status)

Sun  0 20 * * 0 UTC (≈23:00 Kyiv EEST / 22:00 EET)  → sprint-report
       load frozen reports/sprint/<slug>.json
       → re-fetch live status of each frozen issue
       → completion = done/committed; group done by assignee; stuck section
       → persist reports/sprint/<slug>-completed.json
       → post "Completed" to #general
```

`<slug>` = the sprint name slugified (e.g. `ATP 42` → `ATP-42`), used as the
artifact key and the Slack dedup key.

### Scheduling constraints (verified against Vercel docs, 2026-06-16)

Vercel **Hobby**: **100** cron jobs/project, **once-per-day** minimum interval,
**±59 min** precision. Weekly cron expressions run *less* than daily, so they pass
Hobby's daily-limit validation. No 2-cron cap; no GitHub Actions or Pro upgrade
needed.

- **No server-side Kyiv-time gate:** the cron expression pins the weekday
  (Mon / Sun); DST only shifts the fire *hour* within that same weekday, so the day
  is always correct. The ±59 min imprecision and the ~1h DST drift are tolerable for
  an "evening snapshot" — the team confirms plans Monday evening and does not edit
  the sprint minute-to-minute.
- **Sunday timing** is set to `0 20 * * 0` (20:00 UTC = 23:00 Kyiv EEST) rather than
  23:59, so that even a +59 min slip stays **before** Sunday midnight Kyiv.

### Amendment 2026-08-26 — both jobs move to the morning

The evening slots were replaced by morning ones (the team reads #general in the
morning, and the investor draft needs the completion record on Monday):

```
Mon  0 6 * * 1 UTC (≈09:00 Kyiv EEST / 08:00 EET)  → sprint-report  (was Sun 0 20 * * 0)
Tue  0 6 * * 2 UTC (≈09:00 Kyiv EEST / 08:00 EET)  → sprint-commit  (was Mon 0 18 * * 1)
Mon  0 7 * * 1 UTC (≈10:00 Kyiv EEST / 09:00 EET)  → investor-report (was Tue 0 6 * * 2)
```

Consequences:

- **The report now runs after the sprint's calendar end**, and `runSprintReport`
  resolves the board's **active** sprint. The finished sprint must therefore still
  be *open* in Jira on Monday morning — if it is completed in Jira before 09:00, the
  next sprint becomes active, has no frozen baseline, and the report **skips**
  (`status: "no-baseline"`). Complete the sprint in Jira only after the Monday post.
- **The baseline freezes a day later** (Tue 09:00 instead of Mon 21:00), so a full
  extra day of Monday/Tuesday-morning scope changes is baked into the denominator.
- `pickSprintCompletion` still matches: `computedAt` = window.end + 1 day, inside the
  existing +2-day tolerance.
- Ordering on Monday is deliberate: sprint-report 06:00 UTC → investor-report 07:00
  UTC, so the investor draft reads the completion record written an hour earlier.

## Components (isolation & purity)

- **`lib/sprintReport.ts` — PURE, unit-tested.** No React/Next/node imports. The
  logic core:
  - `groupCommitted(issues)` → assignee → status → issues (unassigned bucket last).
  - `computeCompletion(frozen, liveStatusByKey)` → `{committed, completed, rate,
    byAssignee, stuck[]}` where `stuck` = not-done frozen issues with sprintCount ≥ 2,
    each carrying its sprint count.
  - `formatCommittedMessage(...)` / `formatCompletedMessage(...)` → the Ukrainian
    Slack text. Jira keys + summaries kept verbatim; labels/headers Ukrainian.
  - Types: `SprintIssue { key, summary, assignee: {accountId,displayName}|null,
    statusCategory, statusName, sprintCount }`, `SprintSnapshot { sprintId,
    sprintName, slug, capturedAt, issues }`, `CompletionResult`.
- **`lib/jira.ts`** (server-only) — add `fetchSprintIssues(sprintId)`: JQL
  `sprint = <id>` (or the Agile board sprint-issues endpoint), requesting
  `summary, assignee, status`, and the sprint custom field so `sprintCount` can be
  derived. Reuses the existing config/auth/paging helpers.
- **`lib/sprintStore.ts`** — CLI-safe (NOT server-only, no `server-only` import):
  read/write/list `reports/sprint/<slug>.json` and `<slug>-completed.json`. Modeled
  on `lib/reports.ts` but keyed by sprint slug rather than a period key.
- **`lib/runSprint.ts`** — shared orchestration `runSprintCommit(opts)` /
  `runSprintReport(opts)` used by BOTH the CLI and the cron routes (mirrors
  `lib/runNightly.ts`). Handles: pick active sprint, fetch, freeze/load, compute,
  and (when `publish`) post via the `lib/slack.ts` chokepoint. DRY-RUN returns the
  computed data + the message text without posting.
- **`scripts/sprint.ts`** — `npm run sprint -- commit|report [--publish]
  [--channel general] [--sprint <id>]`. **DRY-RUN by default** (prints the artifact
  + the exact Ukrainian message, posts nothing). `--publish` requires `--channel`.
  Runs Node with `--conditions=react-server` (like the other CLIs) because it
  transitively imports the server-only Jira client.
- **`app/api/cron/sprint-commit/route.ts`**, **`.../sprint-report/route.ts`** —
  thin, `CRON_SECRET`-guarded (`isAuthorizedCron`) wrappers that call
  `runSprintCommit({publish:true})` / `runSprintReport({publish:true})`.
  `runtime=nodejs`, `maxDuration=60`.
- **`app/api/sprint/route.ts`** + **`app/(dashboard)/sprint/page.tsx`** — web tab:
  `GET /api/sprint?sprints=1` lists frozen sprint slugs; `?sprint=<slug>` returns the
  committed + completed artifacts; the page renders the same grouped view. Read-only
  (committed artifacts only; never writes `reports/`). Nav entry in
  `app/(dashboard)/layout.tsx` with an `enabled` flag.
- **`vercel.json`** — add the two weekly crons.
- **`package.json`** — add the `sprint` script.

## Idempotency

- Freeze artifact is overwritten by slug → re-running the Monday job the same day
  reproduces the same baseline.
- Every Slack send already funnels through the `lib/slack.ts` reserve-then-send
  chokepoint (`outbound_messages` dedup). The Committed/Completed posts use a stable
  dedup identity of `sprintSlug + kind` so a cron re-fire within the ±59 window does
  not double-post.

## Error handling

- No active sprint → log, skip, no post.
- Completed job with no frozen snapshot for the active sprint → log, skip (cannot
  measure completion without the baseline); surface in the response for cron logs.
- Any Jira/Slack failure short-circuits without a partial post (never post on a
  failed fetch), mirroring the nightly's short-circuit discipline.

## Testing

Pure `lib/sprintReport.test.ts`:

- **Stuck rule:** issue with sprintCount 1 (current only) → not in stuck; sprintCount
  2 → stuck with "2 спринтів"; sprintCount 3 → "3 спринтів". A done issue with
  sprintCount 3 → not stuck (only incomplete issues).
- **Completion math:** 14 of 20 done → rate 70%; 0 committed → guarded (no divide by
  zero).
- **Grouping:** by assignee then status; unassigned bucket ordered last.
- **Message format:** committed + completed Ukrainian message snapshots (keys +
  summaries verbatim).

## Non-goals (YAGNI)

- No per-assignee completion rate (overall rate only).
- No handling of issues added to the sprint after the Monday snapshot (completion is
  measured strictly against the frozen baseline).
- No story-point metric (count only).
- No changelog-reconstruction fallback for the baseline.

## Amendment (2026-08-26): anchor post + threaded detail

**Problem.** The ATP-47 completed report (2026-08-23 23:00 Kyiv) landed in #general as
TWO messages from a single `postMessage` call: `chat.postMessage` silently splits a
`text` over ~4000 chars into consecutive channel messages (unlike `chat.update`, which
errors `msg_too_long` — the case `lib/slackChunk.ts` was written for). The stored
`outbound_messages` row (5655 chars) recorded the ts of the SECOND message, so any
later edit/refresh of a sprint post would have rewritten only its tail.

**Change.** Both subcommands now own the split:

- **Anchor** (one channel post): headline (`взято в роботу: N задач` /
  `виконано X/Y (Z%)`), one line per assignee (count, or `done/committed (rate%)`), the
  stuck COUNT, and a `🧵 … у треді.` pointer. No issue keys — it stays well under the
  cap by construction.
- **Detail** (thread replies under the anchor): the previous per-assignee blocks
  verbatim (done-by-status → transitions → No progress) plus the full stuck list,
  packed greedily into ≤`SLACK_MSG_MAX_BYTES` (3800) messages. A section too big for one
  message is split at LINE boundaries with its header repeated as
  `… _(продовження)_`, so a spilled block never reads as an orphan tail.

**Keys.** Anchor keeps `sprint-committed:<slug>` / `sprint-completed:<slug>`; each reply
is `…:<slug>:t<N>` (1-based). A cron re-fire dedups everything; a run that died
mid-thread re-sends only the replies that never landed (the anchor's ts comes back from
the losing reserve, so the thread stays intact).

**Surfaces.** `formatCommittedMessage`/`formatCompletedMessage` are replaced by
`formatCommittedAnchor`/`formatCommittedDetails` and
`formatCompletedAnchor`/`formatCompletedDetails`; `runSprint`'s results carry
`anchor: string` + `details: string[]` instead of `message`. The CLI prints the anchor
then each reply under a `--- thread N/M ---` separator. The Sprint web tab renders the
structured record and is unaffected.

### Amendment follow-up (2026-08-26): review fixes

Parallel reviews (Fable 5 agent + `codex exec`) on the anchor+thread change found four
real defects, all fixed before landing:

1. **Repack drift across retries (issue loss/duplication).** Reply keys are positional
   (`:t<N>`) but `report` re-fetches Jira live per attempt, so a retry after a partial
   send repacks different text into the same positions — `t1` dedups to the old content
   while `t2` sends the repacked one, dropping or duplicating the boundary issues. Fixed
   by freezing the exact anchor+detail texts in the sprint record (`published[]`, per
   (kind, channel) — `lib/sprintPublish.ts`) before the first send and replaying them
   verbatim on every retry.
2. **Silent chunk loss on a wedged key.** `decideReserve` reclaims only `failed` rows, so
   a hard-killed run (Vercel timeout/OOM never reaches `markFailed`) leaves a `pending`
   row; `sendTracked` then returns an EMPTY ts and the reply never reaches Slack while
   the run reports success. Both the anchor and every reply now throw on an empty ts,
   naming the key to clear. (The generic staleness reclaim in `decideReserve` is a
   cross-feature change and stays out of scope.)
3. **Unbounded anchor.** Neither anchor enforced the byte cap, so a long enough assignee
   roster would let Slack split the anchor itself — reintroducing the exact bug (recorded
   ts on the tail, every reply threaded under it). `assemblePost` now sheds the roster
   into the first thread block when the anchor would exceed the cap.
4. **Foreign `thread_ts` across channels.** Keys carried no channel, so after a partial
   publish to a test channel the #general cron would reuse the test channel's anchor ts
   as `thread_ts` (`thread_not_found`). Keys are now channel-scoped, and `v2` separates
   them from the pre-2026-08-26 single-post keys so a re-run for an old-format sprint
   cannot thread new replies under that old oversized message.

Also fixed: the empty-sprint anchor promised a thread that does not exist; a
pathologically long line produced a header-only message plus headerless fragments; and
the packing tests asserted key PRESENCE (a duplicating implementation passed) with no
orchestration coverage at all — now exact-count assertions plus `lib/runSprint.test.ts`
covering thread_ts, key shape, plan replay, and the empty-ts failures.
