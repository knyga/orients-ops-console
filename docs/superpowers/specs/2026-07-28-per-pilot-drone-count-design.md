# Per-pilot drone-count reports + morning reminder — design

Date: 2026-07-28. Status: approved (user confirmed every decision below).

## Problem

Drone-count reports were one team tally per day, posted by whoever; the verdict
treated a missing report as a day-level machine auto-REJECT (whole crew unpaid).
Policy changes: pilots now submit drone counts **independently of each other**,
and the pay consequence moves from the day to the person.

Drone owners (hardcoded, auditable — like `lib/approvers.ts`):

| Person   | Slack id     | Roster name |
|----------|--------------|-------------|
| Владислав | U091JDN2U5B | Влад        |
| Liubomyr Zaiats | U091JDPH9L5 | Любомир |
| Andrian Korchynskiy | U09AAVAEE6L | Андріан |

## Decisions

1. **Per-person gate replaces the day-level gate.** A drone-owner pilot on a
   flight day's crew must have submitted their **own** drone-count message for
   that date to be paid for that Звіт. A missing submission excludes only that
   pilot from `paidRoster` (flag `no_drone_count`); the day itself can be
   ACCEPTED with zero drone reports. Non-owner crew are never gated.
2. **Attribution is author-based.** Only a message authored by pilot X satisfies
   X's gate. Another pilot listing X's counts still shows in the 🛸 display line
   but does not satisfy X's gate. An approver `eligibility: "counted"` roster
   correction outranks the gate (the existing person-level escape hatch).
3. **Daily 09:00 Kyiv reminder** (11:00 until 2026-07-31) in #field-qa tags only the owners who have not
   yet submitted for today; when all three have submitted, nothing is posted.
   The reminder is the day's canonical thread anchor — pilots are asked to reply
   in its thread.
4. **Date binding:** the reminder targets *today*; a dateless reply in a
   reminder thread is attributed to the anchor's date (deterministic
   thread-parent → date mapping), not the reply's post date. An explicit date in
   the reply text still wins (existing classifier behavior).
5. **Retroactive for the whole current month (July 2026).** July days published
   ⛔ for `droneMissing` flip on the next recompute; July owners without
   own-authored submissions lose their share unless an approver eligibility
   correction re-includes them. Mitigation: dry-run `field-bonus` diff before
   the first publish, `field-instructions` corrections where unfair.
   **SUPERSEDED 2026-08-13 — see the amendment below.**

## Amendment 2026-08-13 — the gate is no longer retroactive

Decision 5's per-date correction mitigation did not hold. Before 2026-07-28
pilots submitted drone counts **collectively** — one crew member posted the
whole team's tally — so author-based attribution carries no signal for those
dates: the gate unpaid people for breaking a rule that did not yet exist. In
July it silently cost Влад 4 of his 5 qualifying Звіт (700 ₴ of 3 350 ₴ paid)
and Любомир 2; only 2 of the 6 cases got a manual eligibility correction, each
carrying a note that says exactly this ("правило особистих звітів діє з 28.07").
Two of the uncorrected days (07-13 в.2, 07-16) had the pilot's own counts
printed inside a teammate's message — the data existed, only the authorship
did not.

**The gate binds only from `DRONE_GATE_EFFECTIVE_DATE` (`lib/droneOwners.ts`,
2026-07-28) onward.** Earlier dates are exempt for every owner. The date is a
required parameter of `owesDroneSubmission`, so neither the pay gate
(`lib/fieldBonus`) nor the display line (`lib/computeVerdicts` «без звіту») can
skip the cutoff or drift from each other. The two manual July corrections stay
in place — they are now redundant but harmless (an `eligibility: "counted"`
override is idempotent).

Recompute effect on July 2026: total 24 401 ₴ → **27 601 ₴**. Влад 700 →
3 350, Любомир 1 367 → 2 750, Андріан 13 600 → 13 967. Данило (3 067 →
2 317), Сергій (2 000 → 1 667) and Тарас (1 867 → 1 750) go **down**, because
re-including a previously gated crew member re-divides that Звіт's
2-person-sized pot among more people (the `splitFactor` rule). No July bonus
figure had been sent to anyone — `outbound_messages` carries no `bonus` row for
the period — so nothing already promised was withdrawn. The only surviving July
`no_drone_count` flag is Любомир on 07-30, which is on/after the effective date
and genuinely his own missing submission.

## Bugs fixed by this work

- **Snapshot-wipe:** `extractDroneReports` replaced a date's entries wholesale on
  every later same-date message — under independent submissions pilot 2 wiped
  pilot 1. Snapshots become per (date, author); authors merge per date.
- **Thread replies invisible:** drone extraction read `fetchMessages`
  (`conversations.history` only). Reminder-thread submissions need
  `fetchRawMessages` (pages `conversations.replies`, carries authorId/thread_ts).
- **Candidate filter gap:** the `/шт/` prefilter would skip a reminder-thread
  reply like «3 дрони справні»; any reply inside a reminder thread is a
  candidate.

## Architecture

- `lib/droneOwners.ts` (new, pure): the hardcoded owners + helpers.
- `lib/extractDroneReports.ts`: input gains `authorId`/`threadTs` + an
  `anchorDateByThreadTs` map; output gains `submittersByDate` (date → authorIds
  with ≥1 entry). Owner-authored reports whose entries name no person are
  re-attributed to the author's roster name for the 🛸 display line.
- `lib/fieldQaExtract.ts`: fetches #field-qa via `fetchRawMessages`; builds the
  anchor map (reminder thread ts → target date) from the bot's OWN durable send
  record — `outbound_messages` rows with feature `drone-reminder`, key
  `drone-reminder:<date>`, via `droneReminderAnchors` — never by parsing message
  text, so a user message that merely looks like a reminder cannot hijack
  thread-date attribution. The reminder's «🛸 Звіт по дронах за DD.MM» first
  line is display-only.
- `scripts/fieldQaReport.ts`: `ReportDay.droneSubmitters?: string[]` — same
  tri-state as `droneReport` (absent = unknown → gate skipped; never reject on
  missing data).
- `lib/fieldDayVerdict.ts`: `droneMissing` hard-fail removed; per-report
  `droneMissingSubmitters` (roster names, display only) added in
  `computeVerdicts`; `verdictPublish` renders «Без звіту по дронах: …» in the 🛸
  region.
- `lib/fieldBonus.ts`: `QualifiedDay.droneSubmitters` (authorIds; undefined =
  ungated); after roster corrections, an owner on the crew without a submission
  and without an explicit `counted` override is excluded and flagged.
- Reminder: pure `lib/droneReminderPlan.ts` (text + missing list, null when all
  submitted; owns the `drone-reminder:<date>` key format + the outbound-row →
  anchor-map helper), server-only `lib/droneReminder.ts` (fetches yesterday +
  today — one day of lookback so a previous-evening submission with an explicit
  date for today still counts at 09:00 — + cached extraction + idempotent
  `postMessage` key `drone-reminder:<date>`), `/api/cron/drone-reminder`
  (`0 6 * * *` UTC ≈ 09:00 Kyiv summer / 08:00 winter — same fixed-UTC
  compromise as the other crons), CLI `npm run drone-reminder` (dry-run default,
  `--publish` posts).

## Non-goals

- No change to the video / dataset / deploy axes or the day-level grace flow.
- No per-owner submission history UI beyond the existing Field Verdict /
  Outbound tabs.
