# 04 — Field-bonus: in-thread ask for unknown roster initials

**Status:** ⏸ DEFERRED — Task 9 of the field-bonus plan, intentionally not built.
**Type:** feature task (not a meta-skill — unlike 01–03).
**Leverage:** low-medium — the feature is fully usable without it; this only
automates resolving a new/unknown person initial seen in a `#field-qa` report.

> The rest of the `field-bonus` feature shipped and merged to `main`
> (`npm run field-bonus`, `/api/field-bonus`, dashboard tab). This is the one
> deferred piece. Deferred because the plan said "reuse the existing `asks`
> store," but that store's `GapType` (`no_dataset | low_video`) feeds the verdict
> answer-ingestion (`field-remember`), which would then try to classify
> roster-question replies as verdict answers — real blast radius. And it's the
> only **outward-facing Slack write** in the feature, so it deserves its own
> careful pass. Decided design: a self-contained store, NOT reuse of `asks`.

## The gap
When a `#field-qa` Звіт names an initial not in the roster map (e.g. `А+М …` on
27.05 — `М` is unmapped), the calculator flags it (`Flag { kind:
"unknown_initial", date, detail }`) and excludes that person from the day. There
is no flow to (a) ask in the report's Slack thread who the initial is, and
(b) ingest the reply into a durable alias so the next run resolves it.

## Evidence in the codebase
- `lib/fieldBonus.ts` already emits `flags` with `kind: "unknown_initial"`.
- `lib/fieldReports.ts` `FieldReport` carries `threadTs` + `unknownInitials[]`
  (everything needed to post in-thread).
- `lib/rosterAliases.ts` (`roster_aliases` table) is the durable alias store the
  ingested answer should write to; `resolveInitial(token, aliases)` already
  consumes overrides.
- `scripts/fieldBonusReport.ts` `parseArgs` already parses `--ask`/`--publish`
  (currently **no-ops**) — wiring them is the work.
- Reference pattern: `scripts/field-ask.ts` + `lib/asks.ts` (DRY-RUN default,
  `--publish` posts, `postMessage(channelId, text, thread_ts)` from `lib/slack`,
  asked-at-most-once tracking). `#field-qa` id is `C08GY2NKF9D`
  (`lib/slackChannels.ts`).

## What to build (own task: spec → plan → SDD)
- A **self-contained** dedup/ask-state store (e.g. a small `bonus_asks` table),
  NOT a widening of `GapType`/`asks` — keep it decoupled from `field-remember`.
- `lib/bonusAsks.ts` (server-only): `askUnknownInitials(reports, { publish, onLog })`
  → for each `(date, initial)` unknown, post `Хто це: «${initial}»? (звіт за
  ${DD.MM})` as a reply to that report's `threadTs`; **DRY-RUN by default**,
  `--publish` to send; ask each `(date, initial)` at most once.
- An ingest step (mirror `field-remember`): read the threaded reply, extract the
  name, `writeAlias(initial, name, source)` so the next `field-bonus` resolves it.
- Expose a helper in `lib/computeBonuses.ts` to return the parsed `FieldReport[]`
  (threadTs + unknownInitials) WITHOUT changing the `BonusReport` return shape
  the web consumes.
- Tests: dry-run prints the right questions/threads and posts nothing; an
  ingested reply records the alias and the next run drops the flag.

## Pointers
- Plan: `docs/superpowers/plans/2026-06-28-field-bonus-recomputation.md` (Task 9).
- Spec: `docs/superpowers/specs/2026-06-28-field-bonus-recomputation-design.md`
  (decision #3 + the unknown-initial flow).
