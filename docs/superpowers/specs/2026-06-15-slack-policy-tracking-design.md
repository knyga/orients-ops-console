# Slack Policy Execution Tracking — Design

**Date:** 2026-06-15
**Status:** Approved (pending spec review)
**Module slot:** a new `Policy Tracking` dashboard tab.

## Goal

Track whether the operational policies announced across our Slack channels are
actually being **executed** — i.e. for each recurring obligation a policy
imposes (*who* must post *what*, in *which channel*, on *what cadence*, with a
*grace period*), did the required post actually appear, on time, by the right
person, during a given period?

The channels carry both the policy announcements (the operational-policy
changelog: budgets, field bonuses, inventory, drone losses) and the execution
events those policies require — weekly/monthly budget status reports, the
Tuesday stats publication, the drone-remainder report, etc. This feature reads
those channels and produces a per-obligation compliance record.

The feature follows this repo's established reporting pattern exactly (mirrors
Jira/GitHub/Vimeo): **skill + CLI produce committed artifacts; the web renders
them, with a live refresh for the current month.**

## House pattern (non-negotiable, from CLAUDE.md + authoring-reporting-features)

- **Two interfaces:** a CLI and a web view over the same data; shared logic in
  pure `lib/` modules (no React/Next imports), Vitest-tested.
- **Secrets server-only:** `lib/slack.ts` imports `"server-only"`, reads
  `process.env`, never reaches the browser. CLIs run under
  `node --conditions=react-server --import tsx` so that import resolves to an
  empty module.
- **Artifact pattern:** `skill → CLI --write → reports/policy/<period>.{json,csv}
  → web renders the committed JSON (hybrid: live Refresh for the current
  month)`. The JSON is lossless and equals what `GET /api/policy?period=…`
  returns; the CSV is a flat, lossy human record. The web **never** writes
  `reports/`.

## Claude-assisted classification = the summaries plumbing

Classification is Claude-assisted and **skill-driven**, reusing the exact
mechanism Jira already uses to inject Claude-generated text into a committed
artifact (`--dump-tickets` → sonnet subagents → `--summaries-file`):

- The deterministic CLI computes each obligation's expected occurrences +
  candidate evidence and assigns a *deterministic* status
  (`MISSING` / `PENDING` / `NEEDS_REVIEW`).
- `npm run policy -- … --dump-occurrences` emits the occurrences needing a
  human/AI verdict as JSON.
- Claude Code **sonnet subagents** (one per month) read that, judge each
  occurrence `DONE` / `LATE` / `PARTIAL` / `MISSING` with a one-line rationale,
  and write `{ "<occurrenceId>": { verdict, rationale } }`.
- `npm run policy -- … --verdicts-file <path>` merges those verdicts into the
  report and writes the committed artifact (`--verdicts-file` implies
  `--write`). The dev reviews verdicts before committing.

There is **no server-side LLM call** — verdicts only ever come from a committed,
human-reviewed report. The live web path shows the deterministic picture
(satisfied/missing/pending so far), without verdicts.

## Data flow

```
dev runs Claude Code + the policy-tracking skill
  → npm run policy -- --start … --end … --dump-occurrences   (DETERMINISTIC: fetch Slack → schedule → evidence)
  → sonnet subagent(s) classify each NEEDS_REVIEW occurrence → {occurrenceId: {verdict, rationale}}
  → npm run policy -- --start … --end … --verdicts-file v.json   (merges verdicts, writes reports/policy/<period>.{json,csv})
  → dev reviews verdicts, commits the artifacts
web (app/(dashboard)/policy-tracking) renders the committed JSON via GET /api/policy?period=<key>;
  the current month can be Refreshed live (deterministic schedule, no verdicts).
```

## Module layout

Mirrors the Jira feature file-for-file.

- **`lib/slack.ts`** — *server-only.* Reads `SLACK_TOKEN` (+ optional
  `SLACK_WORKSPACE` for permalinks). `fetchMessages(period): Promise<SlackMessage[]>`
  across every tracked channel via `conversations.history` (epoch
  `oldest`/`latest`, cursor pagination, `cache: "no-store"`), resolving author
  ids → names via one `users.list`. Throws a typed `SlackError`
  (→ 502 upstream / 500 config), mirroring `lib/jira.ts`. Network-bound,
  untested.
- **`lib/slackChannels.ts`** — committed `{ id, name }[]` of tracked channels.
- **`lib/policyRegistry.ts`** — *pure.* `Obligation`/`Cadence` types, the
  committed `OBLIGATIONS` array (parsed from the changelog), and
  `activeObligations(period, obligations?)` filtering by `[effectiveFrom,
  effectiveTo]` overlap. Each obligation: `id`, `title`, `description`,
  `channel`, `responsible[]`, `cadence`, `gracePeriodWorkingDays`,
  `effectiveFrom`, `effectiveTo?`, `keywords?`. Effective-date ranges are
  load-bearing — policies evolve (переоблік 92/8 → 80/20 on 2026-04-08; the
  Tuesday stats publication began 2026-02-23; dynamic budgets from 2026-05-01).
  Tested.
- **`lib/policySchedule.ts`** — *pure, the `jiraStats.ts` analogue.* Owns the
  canonical `SlackMessage` shape (lib/slack maps Slack's raw response into it),
  the working-day helpers (`isWorkingDay`, `addWorkingDays`; Mon–Fri, holidays
  out of scope), occurrence enumeration, and `buildSchedule(obligations,
  messages, period, today)`. For each active obligation it enumerates expected
  occurrences from the cadence (each with `dueDate`, candidate
  `windowStart`/`windowEnd` = reporting window + grace), gathers candidate
  messages (same channel, within window), and assigns the deterministic status:
  `MISSING` (past due, zero candidates), `PENDING` (not yet due / within grace,
  no candidate), `NEEDS_REVIEW` (has candidate). Per-event obligations are
  skipped with a logged note (never silently dropped). All calendar math on
  `YYYY-MM-DD` in UTC (consistent with Jira/GitHub; documented). Tested.
- **`scripts/policyReport.ts`** — *pure CLI shaping, the `jiraReport.ts`
  analogue.* `parseArgs` (`--start`/`--end`/`--format`/`--write`/
  `--dump-occurrences`/`--verdicts-file`), `resolvePeriod`, `applyVerdicts`
  (schedule + verdicts → `PolicyReport`), `formatTable`, `toCsv` (RFC-4180
  `csvField`). Owns `PolicyReport`/`OccurrenceReport`/`Verdict` types. Tested.
- **`scripts/policy.ts`** — *CLI, the `jira.ts` analogue.* Loads `.env`,
  resolves the period, fetches via `lib/slack`, builds the schedule. With
  `--dump-occurrences` prints the `NEEDS_REVIEW` occurrences as JSON and exits.
  Otherwise prints JSON/table; on `--write`/`--verdicts-file` calls
  `writeReport("policy", period, { json, csv })`. Untested.
- **`app/api/policy/route.ts`** — *hybrid route, the `app/api/jira/route.ts`
  analogue.* `?periods=1` → `listPeriods`; `?period=<key>` → `readReportJson`
  (404 absent / 400 bad key); `?start=&end=[&refresh]` → live fetch +
  `buildSchedule` (deterministic, no verdicts). `runtime="nodejs"`,
  `dynamic="force-dynamic"`.
- **`app/(dashboard)/policy-tracking/page.tsx`** — uses the `usePeriodReport`
  hook (period picker, render committed, Refresh live for the current month).
  `mapCommitted` keeps verdicts; `mapLive` renders deterministic status only
  (the committed-vs-live shape divergence the hook supports). Renders a
  compliance board grouped by obligation: each occurrence shows a status/verdict
  badge, supporting evidence (author, time, excerpt), and a Slack permalink. Tab
  added to `app/(dashboard)/layout.tsx`.
- **`.claude/skills/policy-tracking/SKILL.md`** — cloned from
  `jira-dev-reporting/SKILL.md`. Documents the domain invariants, the CLI flags
  and artifact paths, and the standing monthly subagent classification flow
  (dump → sonnet subagents judge with the verdict rubric → `--verdicts-file`).

## Cadence model (v1)

First-class, deterministic: **weekly** (a weekday, e.g. Monday budget status)
and **monthly** (by a deadline day-of-month, e.g. "by the 5th"; the candidate
window is the 1st through the due day, so a "first half of the month" deadline
is just `monthly` with `dueDay: 15`). The leniency nuance of a window deadline
vs a hard deadline lives in the obligation's `description`, which the verdict
step reads — it does not need its own cadence variant.

**Out of scope for v1 (documented, not silently dropped):** *per-event*
obligations whose due date is triggered by an external event we lack a source
for — the drone-remainder report (≤1 working day after a flight day) and the
unrecorded-video/-dataset explanations. Stored with `cadence: { type:
"per-event" }`, skipped by the scheduler with a logged note in the output.

## Error handling

- Missing `SLACK_TOKEN` → `SlackError`; the CLI exits non-zero, the route
  returns 500 (config) — mirrors Jira/Vimeo.
- Slack upstream failure → `SlackError` with HTTP status → route 502.
- Web: a missing committed report for the current month surfaces the
  "Refresh live" affordance (handled by `usePeriodReport`); other periods 404.

## Testing & conventions

- **Unit-tested (pure):** `lib/policyRegistry.ts` (`activeObligations`
  effective-date filtering), `lib/policySchedule.ts` (working-day math,
  occurrence enumeration, candidate matching, status assignment, per-event
  skip), `scripts/policyReport.ts` (`parseArgs`, `resolvePeriod`,
  `applyVerdicts`, `toCsv`).
- **Not unit-tested:** `lib/slack.ts` (network), like `lib/jira.ts`.
- `@/*` import alias; TypeScript `strict`. `npm test` / `npm run lint` /
  `npx tsc --noEmit` all clean.
- `.env.example` gains `SLACK_TOKEN` (scopes `channels:history`,
  `groups:history`, `users:read`) and optional `SLACK_WORKSPACE` (subdomain, for
  permalinks).

## Known limitations (v1)

- Per-event obligations are not scheduled — see Cadence model.
- Public holidays are not modeled in working-day grace math.
- Calendar math is UTC (matches Jira/GitHub), not Kyiv.
- No opus `--classify` convenience path in v1 (the subagent `--verdicts-file`
  flow is the classification path); can be added later mirroring Jira's
  `--summarize` + `lib/summarize.ts` if a one-command path is wanted.
