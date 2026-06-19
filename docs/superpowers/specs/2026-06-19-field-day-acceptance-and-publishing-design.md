# Design: Field-day acceptance verdict + proactive Slack publishing

Date: 2026-06-19
Status: Proposed (pending review)

**Depends on** `docs/superpowers/specs/2026-06-19-field-qa-bot-image-flight-time-design.md`
(phase A — flight time from the stats-bot image). This doc is phases **B**
(per-day acceptance verdict) and **C** (publishing).

## Goal

For each flight day, compute whether the day's field bonus is **accepted**, and
(opt-in) have the bot proactively publish that verdict back to #field-qa. This
operationalizes the recording-completeness gate the team currently tracks by
hand in `Статистика`.

## Policy basis (docs/operational-policies-changelog.md)

- Bonus accrues for a flight day only if **all flights are recorded** (2026-04
  rule). Practical proxy: **Vimeo video minutes ≥ 50% of the bot's airborne time**
  (the temporary tolerance "через метрики бота"; Vimeo is the cross-check).
- **Datasets are part of recording completeness**: published to Google Drive
  with a notice in **#datasets** within one working day (2026-04-01).
- Publication grace (per user, 2026-06-19): **3 working days** after the flight
  day to publish results and upload all videos. (Supersedes the "1 working day"
  caveat in CLAUDE.md / reconcile.ts docs.)
- Misses are **never auto-rejected** — force-majeure / tech-failure exceptions
  exist and are confirmed by Oleksandr or Bogdan. So the bot's negative verdict
  is "needs review," not "rejected."

## Phase B — acceptance verdict

### Verdict states (per flight day D)

A "flight day" = a day the stats bot reports airborne flight (`Сьогодні літали =
Так`, airborne > 0), keyed by the bot message's date.

- **ACCEPTED** — within the grace window, BOTH hold:
  1. Vimeo video minutes attributed to D ≥ `MIN_RATIO` (0.5) × airborne minutes(D);
  2. a #datasets upload notice for D exists (or an explicit "no dataset" note).
- **PENDING** — `today` ≤ D + 3 working days and the conditions aren't yet met
  (videos/datasets may still arrive).
- **NEEDS_REVIEW** — grace elapsed and a condition is unmet. Human decides
  (exceptions). Never an auto-reject.

### Inputs & sources

- **airborneMinutes(D)** — phase A (bot image), per flight day.
- **videoMinutes(D)** — from Vimeo (`lib/vimeo` / the field-ops report).
- **datasetPosted(D)** — a message in **#datasets** within [D, D+3wd] that
  references D (e.g. `Датасет за <D>` or an explicit "немає датасету" note for D).
  Detected from Slack text (we already fetch #datasets); recognition is keyword +
  date based, surfaced with the message permalink as evidence (a human/LLM
  confirms ambiguous cases — same posture as policy verdicts).

### OPEN MODELING QUESTION — video↔flight-day attribution

`reconcile.ts` groups Vimeo by **upload date**. With a 3-working-day grace,
videos for flight day D can be uploaded on D…D+3wd, and windows for consecutive
flight days overlap. We must attribute each video to exactly one flight day to
avoid double counting. **Proposed default (to confirm):** a video is attributed
to the **most recent flight day on or before its Kyiv upload date** (so a video
uploaded 2 days after a flight counts for that flight, not a later one); only
days the bot marks as flight days are attribution targets. This needs your
confirmation before implementation — it materially changes verdicts. The May
`Статистика` sheet may already imply a rule; if so we adopt that instead.

### Where it lives

- Pure logic in `lib/fieldDayVerdict.ts` (new): `verdictForDay({airborneMinutes,
  videoMinutes, datasetPosted, flightDate, today, graceWorkingDays})` →
  `{ status, ratio, reasons[] }`. Reuses `MIN_RATIO` and the working-day math
  from `lib/policySchedule` (extract the shared `addWorkingDays`/`isWorkingDay`
  into a small `lib/workdays.ts` so both features use one copy). Unit-tested.
- Surfaced in the CLI (`npm run fieldqa`/`fieldops` verdict view) and the
  Field-QA web tab (a status column with evidence links). Committed artifact
  carries the per-day verdict.

## Phase C — proactive Slack publishing (opt-in, dry-run first)

### Capability

A command that posts a concise per-day (or per-period summary) verdict into
**#field-qa**: e.g. "✅ 2026-06-18 accepted (video 206m ≥ 50% of 18m airborne;
dataset ✓)" or "⚠️ 2026-06-13 needs review — no dataset notice by 2026-06-18".

### Safety (non-negotiable)

- Requires the **`chat:write`** scope (added to the bot + reinstall). Until then,
  publishing is unavailable; the verdict still computes/surfaces in B.
- **`--dry-run` is the default.** It prints the exact message(s) it would post and
  the target channel, and writes nothing. A real post requires an explicit
  `--publish` flag.
- `lib/slack.ts` gains `postMessage(channelId, text)` (server-only, `chat:write`).
- Idempotency: the bot records what it has posted (in the committed artifact) and
  will not double-post the same day's verdict.
- The bot posts **only** to channels in `lib/slackChannels` and only verdict
  text it generated — no echoing of arbitrary content.

### Posture

This is the only outward-facing write in the whole console. It ships disabled
(dry-run), behind an explicit flag, after you've reviewed dry-run output. Cadence
(manual `npm run` vs scheduled) is decided after the dry-run looks right — not in
this spec.

## Testing

- Pure `verdictForDay`: ACCEPTED/PENDING/NEEDS_REVIEW across ratio, dataset
  presence, and grace boundaries (today before/after D+3wd); `addWorkingDays`
  edge cases via the shared `lib/workdays`.
- Dataset detection: unit-test the recognizer on real #datasets text samples.
- Publisher: `postMessage` not unit-tested (network); the dry-run formatter IS
  unit-tested. Manual: `--dry-run` shows correct text; a single `--publish` to a
  test thread before any production use.

## Conventions

- Server-only discipline for `lib/slack` (now also `chat:write`).
- Pure verdict + formatting logic unit-tested; relative imports in scripts.
- `MIN_RATIO`, working-day math, and channel config are shared, not duplicated.
- `.env.example` + the skill document the `chat:write` requirement and the
  dry-run-by-default publishing posture.
