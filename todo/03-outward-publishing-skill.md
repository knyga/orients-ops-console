# 03 — Safe outward-publishing skill

**Status:** not started
**Leverage:** medium, but high-risk-reducing — these are the only commands that
write *outside* the repo (post to Slack), so the guardrails are worth encoding
before the pattern spreads.

## The gap
The console gained its first **outward-facing writes**. The dry-run-by-default /
explicit-publish-gate / idempotency pattern is real and reusable, but lives only
as prose in CLAUDE.md and two scripts. A skill should make the safety contract
explicit so future publishing features inherit it instead of improvising.

## Evidence in the codebase
- `npm run field-publish` — DRY-RUN by default; only SETTLED verdicts
  (never PENDING); a real post needs `--publish` + `--channel <name>` +
  `chat:write`; idempotent via `reports/published/<period>.json`. "The only
  outward-facing write in the console."
- `npm run field-ask` — DRY-RUN by default; `--publish` posts; asks each
  `(gapType, date)` at most once, tracked in `reports/asks/<period>.json`.
- `npm run field-remember` — DRY-RUN by default; `--write` records outcomes.

## What the skill should encode
- **Dry-run is the default; sending requires an explicit `--publish` flag.** No
  command posts without it.
- Always print the exact messages + target channel before sending.
- Use a private test channel before any real team channel (e.g. before #field-qa).
- Idempotency: every published unit is recorded in a `reports/<feature>/` ledger
  and skipped on re-run; "ask at most once per (gap, date)".
- Required scope/auth (`chat:write`) and the tracked-channel constraint.
- Checklist an agent must satisfy before ever passing `--publish`.

## Acceptance
- Any new "post X to Slack" feature can be built to this contract from the skill
  alone, and an agent will never send a live message during a dry-run request.
