# 02 — Verdict + resolutions pipeline skill

**Status:** not started
**Leverage:** high — a whole new domain (S3–S6) shipped with no skill to operate
or extend it.

## The gap
The console grew a **stateful, human-in-the-loop decision pipeline** that is
unlike the read-only reporting features. Nothing documents how to run it end to
end, the verdict state machine, or how to add a new verdict-style feature.

## Evidence in the codebase
- `lib/fieldDayVerdict.ts` — pure `verdictForDay(...)` →
  `ACCEPTED / PENDING / NEEDS_REVIEW / ACCEPTED_EXCEPTION`, with `reasons[]` and a
  grace window; `applyResolution`.
- `lib/resolutions.ts` — committed override store (`reports/resolutions/store.json`)
  that flips a day's verdict.
- `lib/datasetNotice.ts` — `#datasets` notice recognizer feeding the verdict.
- CLIs: `field-verdict` → `field-publish` → `field-ask` → `field-remember`
  (S3–S6 in CLAUDE.md). The loop: compute verdict → publish settled → ask the
  team about NEEDS_REVIEW gaps → ingest replies → record an exception → re-verdict.
- Spec: `docs/superpowers/specs/2026-06-19-field-day-acceptance-and-publishing-design.md`.

## What the skill should encode
- The verdict state machine and what each status means / what moves between them.
- Required input order (`slack-sync` + `field-qa --write` before `field-verdict`).
- The resolutions override store: shape, when a human exception is recorded, how
  it changes the next verdict run.
- The full operator loop (verdict → ask → remember → re-verdict) as a runnable
  recipe for a given month.
- The reusable pattern for *any* future "verdict + operator-override" feature
  (vs read-only reporting).

## Acceptance
- A "give me June's field-day verdicts and chase the open ones" request is
  answerable by following the skill without re-reading the plan.
- Captures the override-store + grace-window + `reasons[]` pattern generically.
