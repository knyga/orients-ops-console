---
name: field-instructions
description: Use when an approver wants the bot to change field-verdict data (crew, per-person eligibility, day accept/reject, dataset, video, airborne minutes) from their Slack verdict-thread replies, or to clear the backlog of pending approver instructions. Confirm-first in Slack; direct-apply via the CLI.
---

# Field instructions (unified approver data-overwrite)

One path for every approver-driven correction to a published field-day verdict,
superseding the single-axis `field-roster` (crew) and `field-approvals` (day) CLIs.

## Axes
`crew` (set/add/remove) · `eligibility` (count/don't-count) · `day`
(accept-exception/reject) · `dataset` (waive/decline) · `video` (waive) ·
`airborne` (correct the minutes the day is judged against).

## Two interfaces

**Realtime, confirm-first (Slack).** When an authorized approver
(`lib/approvers.ts`) replies in a verdict thread, the events webhook
(`app/api/slack/events/route.ts` → `lib/applyInstructionReply.ts`) classifies the
reply (`lib/instructionClassify.ts`, one Claude tool-call), **echoes** the change
(`📝 Зрозумів: …. Підтвердьте «так»/👍 або «ні».`), and stores a PROPOSED row in
`proposals`. It applies **only after** the approver confirms; "ні" cancels; a
question is a silent no-op. Idempotent (unique `source_reply_ts` + pure
`lib/proposalDecision.ts` state machine). Requires `ANTHROPIC_API_KEY` on Vercel —
if missing, the webhook posts a loud in-thread failure notice.

**CLI (batch / operator).** `npm run field-instructions` — DRY-RUN by default.
- *Sweep:* `-- --start YYYY-MM-DD --end YYYY-MM-DD [--write]` classifies approver
  replies across the window's verdict threads and applies the last decisive
  instruction per day (the operator running `--write` is the confirmation).
- *Manual:* `-- --date D --set-crew "A,B" | --add-crew X | --remove-crew X | --airborne N | --accept | --reject [--by NAME] [--reason "…"] --write`.
- `-- --list` prints pending proposals + applied corrections (= `GET /api/instructions`, the **Instructions** tab).

Run `npm run slack-sync` first (reads the mirror). After `--write`, re-run
`npm run field-verdict -- --write` and `npm run field-bonus` to reflect changes.

## How it applies (reuse, disjoint regions)
`lib/applyInstruction.ts` routes to the existing primitives: day →
`applyApproverDecision` (strikes the body), crew/eligibility → `applyRosterDecision`
(edits the `👥 У полі:` suffix), dataset/video → `upsertResolution`, airborne →
`upsertAirborneOverride` (overlays `computeVerdicts` step 1). Each axis owns its
Slack region + Ukrainian ack, so they never clobber each other. Crew corrections
seed the baseline from the **current effective crew** (published suffix), so
`додай Тараса` on a no-Звіт day keeps the existing crew instead of dropping it.

## Gotchas
- `readPublished` is period-MONTH keyed; the CLI filters to the `--start/--end`
  day window (`filterEntriesToWindow`) so a single-day run doesn't touch the month.
- The bonus gate (3h deploy + video) is separate: adding crew to a 0-video day
  fixes attribution/display but earns no bonus for that day.
