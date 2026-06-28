# Rolling field-bonus notification — design

Date: 2026-06-28 (revised after discovering the recomputation feature already ships)
Status: Approved (brainstorm) → ready for implementation plan
Author: Oleksandr Knyga (with Claude)

## Context — what already exists

The **field-bonus recomputation feature is already shipped** (`main`): `npm run
field-bonus` (`scripts/field-bonus.ts` → `lib/computeBonuses.ts`
`computeBonusReport`), `GET /api/field-bonus`, the dashboard tab, the
`field-bonus` skill, and its own spec/plan (`2026-06-28-field-bonus-recomputation-*`).
It computes, for a window, a `BonusReport`:

- `days: DayBonus[]` — per flight day: `{ date, roster (resolved names),
  deployMin, videoMin, counted, early, weekend, reason }`. A day is `counted`
  iff deployment ≥ 3h AND video ≥ 2min (the real bonus gate).
- `people: PersonBonus[]` — per-person period totals incl. the **drone-loss
  multiplier** and the team-wide >3-loss zeroing (`net`).
- rate constants in `lib/fieldBonus.ts`: `TRIP=700`, `EARLY=200`, `WEEKEND=300`.
- roster resolution: `lib/fieldRoster.ts` (`SEED_ALIASES`) + durable DB aliases
  (`lib/rosterAliases.ts`, `roster_aliases` table).

The verdict pipeline already settles acceptance rolling: `field-verdict` →
`field-publish` (posts each day's verdict, storing the thread-root `ts` in the
`published` table) → `field-ask`/`field-remember`/`field-approvals`. The grace is
3 working days (`PENDING` inside the window).

## Problem

None of the shipped pieces **notifies field participants of their bonus rolling**.
The recomputation feature is a report/dashboard ("what did X earn in May?"). The
user wants: as each flight day's acceptance **settles** (after the 3-working-day
lag, or via exception/approval), post that day's **per-person breakdown in the
day's verdict thread** and **DM each participant their share** — to spread the
work across the month instead of an end-of-month crunch.

## Scope

In scope: a thin **rolling notifier** layered on the existing feature.

- Derive each day's per-person amount from the existing `DayBonus` (no new
  calculator).
- Resolve each roster **name → Slack user id** (new — no `slackId` exists today).
- Add a Slack DM capability (`openDm`).
- A `bonus_notified` idempotency table.
- Extend the existing `scripts/field-bonus.ts` CLI with `--notify` (+ `--channel`),
  reusing the existing `--publish` flag as the send gate. **Dry-run by default.**

Out of scope (unchanged from reality):

- The calculator, rates, roster, **loss multiplier**, artifacts, web view — all
  already shipped; reused as-is.
- The unknown-initial in-thread ask (todo `04`, separately deferred).
- Actual payment — DMs are **informational**; payout requests go to the finance
  operator (Марина).

## Trigger & amount

- **Trigger (rolling):** a day is eligible to notify only when its
  `field-verdict` status is **FINAL**: `ACCEPTED` or `ACCEPTED_EXCEPTION`
  (earned breakdown + DMs) or `REJECTED` (no-bonus note, no DMs). `PENDING`
  and `NEEDS_REVIEW` are both skipped — `NEEDS_REVIEW` is not final because a
  human may still resolve it to `ACCEPTED_EXCEPTION`.
- **Amount (provisional):** from the `field-bonus` `DayBonus` for that date:
  - `counted` day → **earned**: per roster member `base = TRIP`, `+EARLY` if the
    day is `early`, `+WEEKEND` if `weekend`; `total` per person; day total = sum.
  - not `counted` (or verdict rejected/needs-review with no bonus) → **no bonus**.
- The amount is **provisional**: it excludes the monthly drone-loss multiplier
  (which can only settle at month-end). Every message says so.

## Components

### Reused as-is
`computeBonusReport` (or the committed `reports/field-bonus/<period>.json`),
`field-verdict` report (settled gate), the `published` table (thread root `ts`),
`lib/fieldBonus.ts` constants, `lib/slackChannels.ts`.

### New — pure (`lib/`, unit-tested)
- `lib/bonusNotify.ts`:
  - `dayPersonBonuses(day: DayBonus): { name: string; base: number; early: number; weekend: number; total: number }[]` — per-person amounts for a counted day ([] otherwise).
  - `formatThreadBreakdown(date, people, dayTotal)`, `formatDm(date, person)`, `formatNoBonusNote(date, reason)` — Ukrainian; every earned message carries the **provisional** caveat + the finance-operator pointer.
- `lib/fieldSlackIds.ts`:
  - `SLACK_ID_OVERRIDES: Record<string,string>` (committed name→id for tricky cases).
  - `matchSlackId(name, users, overrides): string | null` — override first, then exact display/real-name match against the live directory; `null` (skip DM, flag) when ambiguous/missing. Pure.
- `lib/bonusNotified.ts` — pure merge helpers (`isThreadNotified`, `isDmSent`, `recordThread`, `recordDm`) + thin drizzle read/write over a new `bonus_notified` table. Mirrors `lib/published.ts`.

### New — server (`lib/`)
- `lib/slack.ts`: `openDm(userId): Promise<string>` (`conversations.open`) +
  `listUsers(): Promise<{id,name}[]>` (exported wrapper over the existing
  `userMap` page-walk).

### New — schema
- `bonus_notified` table: PK `(period, date)`, `threadTs text`, `dms jsonb`
  (`{ slackId, ts, amount }[]`). Drizzle migration via `npm run db:generate`.

### Extended — CLI
- `scripts/fieldBonusReport.ts`: add `--notify` + `--channel` to `parseArgs`/
  `BonusArgs`; add `buildNotifyPlan(days, verdictByDate, published, log)` and
  `formatNotifyDryRun(plan)` (pure).
- `scripts/field-bonus.ts`: when `--notify`, read the `field-verdict` report +
  `published` log, join with the computed `BonusReport.days`, resolve Slack ids
  (`listUsers` + `matchSlackId`), and **dry-run** print, or with `--publish
  --channel <name>` reply in each day's verdict thread + DM each matched
  participant, recording every send in `bonus_notified`.

## Data flow

```
field-verdict report ─┐                        ┌─ published table (thread ts)
                      ├─ join by date ─ notify ┤
field-bonus DayBonus ─┘  (settled & amount)    └─ bonus_notified (idempotency)
                                               └─ listUsers + matchSlackId → DM
```

1. Day eligible iff verdict status ≠ PENDING and not already thread-notified.
2. Earned (counted) → thread breakdown + DM each matched participant not already
   DMed; unmatched names → no DM, flagged for a human.
3. Not counted → one-time no-bonus thread note; no DM.
4. Every send recorded in `bonus_notified` (so the cron-safe re-run is a no-op).

## Safety

- **Dry-run by default**; a real send needs `--notify --publish --channel <name>`
  (a tracked channel; use a private test channel first).
- Every thread/DM gated by `bonus_notified` — never notify a day/person twice.
- A day must already be `published` (we reply in its thread); unpublished days
  are skipped with a warning.
- Unmatched name → **skip the DM**, flag it; never DM a guessed id.
- Provisional wording in every earned message; DMs state payout requests go to
  the finance operator.

## Rollout

Manual-first: run `npm run field-bonus -- --notify` (dry-run), then with
`--publish` to a test channel, for ~a week. A scheduled cron is a later,
separate follow-up (no crons exist in the repo yet).

## Testing

- `lib/bonusNotify` — per-person amount derivation (base/early/weekend, non-counted → []); message formatting (provisional caveat present, DM shows only the recipient).
- `lib/fieldSlackIds` — override precedence, exact match, ambiguous/missing → null.
- `lib/bonusNotified` — idempotency merge helpers (no double record, no mutation).
- `scripts/fieldBonusReport` — `--notify`/`--channel` parsing; `buildNotifyPlan`
  (PENDING skipped, already-notified skipped, unmatched → flagged); dry-run text.

## Risks

- **Name→id matching** without Claude may miss nicknames; mitigated by the
  committed override map + skip-and-flag on miss.
- **Provisional vs monthly loss** — wording sets the expectation; the month-end
  loss adjustment stays the recomputation feature's job.
- **Cron blast radius** — deferred; manual-first + idempotency + dry-run default.
