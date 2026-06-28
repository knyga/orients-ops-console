# Rolling field-bonus calculation & notification — design

Date: 2026-06-28
Status: Approved (brainstorm) → ready for implementation plan
Author: Oleksandr Knyga (with Claude)

## Problem

Today the field pipeline settles **acceptance** day-by-day (the `field-verdict` →
`field-publish` → `field-ask`/`field-remember`/`field-approvals` flow, with a
3-working-day grace window), but it never computes an actual **bonus amount** and
never tells participants what they earned. Bonus figures live only as Ukrainian
prose in `docs/operational-policies-changelog.md`, and payout happens manually at
month-end.

We want to move bonus calculation to a **rolling, day-by-day** rhythm: the moment a
flight day settles (after the 3-working-day lag, or via an exception/approval),
compute the per-person bonus and notify — a breakdown in the day's Slack thread and a
personal DM to each participant. The goal is to spread the work across the month
instead of a single end-of-month crunch.

## Scope

In scope (v1):

- **Field-trip bonuses only**, per person physically in the field on an *accepted* day.
- Rolling notification as each day **settles** (SETTLED = `ACCEPTED` /
  `ACCEPTED_EXCEPTION`; non-earning settled = `REJECTED` / `NEEDS_REVIEW` past grace).
- Thread breakdown + per-person DM (see Messaging).
- A read-only web view + a dry-run-default CLI (`npm run field-bonus`).

Explicitly out of scope (v1), with rationale:

- **Monthly drone-loss penalties** (2 losses → −50% of the month's field bonuses; 3 →
  −100%; >3 team-wide → nobody). These are inherently monthly and **retroactive** — a
  loss late in the month claws back bonuses already notified earlier, which cannot be
  settled rolling. v1 notifies the **provisional** earned day-bonus and says so
  explicitly in every message. The monthly loss multiplier remains a separate
  month-end reconciliation.
- **Assembler fund** (50 грн/h + 50 грн/drone, split among assemblers). It is
  **cancelled from 2026-07-01** and assemblers do not appear in `#field-qa` (they are
  workshop, not field) — there is no roster source. `rates.json` still encodes it with
  `effectiveTo: 2026-06-30` for a faithful history, but the calculator has no roster to
  apply it to, so it is documentation only.
- **Actual payment.** Per policy, bonus requests go to the finance operator (Марина).
  Our DMs/threads are **informational** — they state the earned figure, they do not pay.

## Rate rules (what `rates.json` must encode)

All entries are **effective-dated** (`effectiveFrom`, optional `effectiveTo`); the
calculator resolves the entry in force on the flight date.

Field-trip bonus (per person in the field, accepted day, trip ≥ 3h):

- Base **700 грн** (since 2026-04; **400 грн** before that — keep the historical entry).
- **+200 грн** early arrival — arrived in the field before **12:30** (detectable from
  the report time window, e.g. `А+Т 14:30-18:30`).
- **+300 грн** weekend trip (derivable from the date).

Soft cap: `maxPaidParticipantsPerDay` (default: **no cap**). When a day has more paid
participants than the cap, do not silently drop anyone — **flag** the day in the
dry-run and the thread so a human can check (the 2025-09 "max 2 people/day" rule was
never restated after the 2025-11 simplification; status ambiguous).

Assembler fund (history only): 50 грн/h field work + 50 грн/drone ready for field test,
split evenly among assemblers, field-trip days only; `effectiveTo: 2026-06-30`.

### Keeping `rates.json` in sync with the changelog

`docs/operational-policies-changelog.md` is the source of truth; `rates.json` is a
machine-readable projection that **must not drift**. `lib/bonusRates.ts` exposes
`checkDrift()` and the CLI exposes `--check`: it compares a stored marker (a content
hash of the "Польова робота, бонуси" section of the changelog, persisted in
`rates.json` as `changelogMarker`) against the current changelog. If the changelog
moved but `rates.json` wasn't updated, `--check` exits non-zero and prints a warning.
Whoever edits the changelog updates `rates.json` (rates + marker) in the same change.

## Architecture

Follows the house pattern: pure `lib/` logic (unit-tested, no React/Next/network) +
`server-only` network clients + a dry-run-default CLI that, with `--write`, persists a
committed JSON (the web render source) + CSV (a flat human record), and a read-only
web view that renders the committed JSON. The web never writes `reports/`.

### Pure `lib/` modules (no network, unit-tested)

- **`lib/bonusRates.ts`** — loads + validates `reports/field-bonus/rates.json`.
  - `rateFor(date: string): RateEntry` — the entry in force on that date.
  - `checkDrift(): { ok: boolean; reason?: string }` — changelog-vs-rates guard.
  - Pure; client-bundle-safe (no `node:fs` in the hot path — file read is injected/
    done by the caller, mirroring `lib/period.ts` vs `lib/reports.ts`).
- **`lib/fieldBonus.ts`** — the calculator. Pure:
  - Input: settled day status, `participants[]` (`{ name?, slackId?, initials,
    arriveAt?, departAt?, confidence }`), the flight date, and the resolved `RateEntry`.
  - Output: `{ date, dayTotal, perPerson: [{ initials, name?, slackId?, base, early,
    weekend, total, confidence }], flags: string[], earned: boolean }`.
  - Encodes base + early(<12:30) + weekend, the soft `maxPaidParticipantsPerDay` flag,
    "no bonus" for non-earning settled days, and integer-грн rounding.

### Roster (the "from #field-qa" source)

- Extend the **`field-qa` extractor** (`scripts/fieldQa.ts` + its lib) to also emit a
  `participants` array per day: raw `{ initials, arriveAt, departAt }` parsed from the
  report text. Deterministic half; committed into `reports/field-qa/<period>.json`
  (additive — existing consumers ignore the new field).
- **Identity resolution** (initials → real name → Slack user ID) happens in the bonus
  step, via Claude + the existing `users.list` map (`lib/slack.ts` `buildUserMap`).
  Each resolved person carries a **confidence**. The resolution result is persisted
  into the bonus artifact for audit (so a later run is reproducible/reviewable).
  - Needs `ANTHROPIC_API_KEY` (same discipline as `field-remember` / `--summarize`).

### Slack (`lib/slack.ts`)

- Add **`openDm(userId: string): Promise<string>`** (`conversations.open` with
  `users=<id>`) returning the DM channel id; then reuse `postMessage`.
- Thread replies reuse `postMessage(channelId, text, threadTs)` with the `ts` already
  stored per date in `reports/published/<period>.json`.
- `server-only`; CLI reaches it under `--conditions=react-server` like the rest.

### CLI — `scripts/field-bonus.ts` (`npm run field-bonus`)

Flags: `--start YYYY-MM-DD --end YYYY-MM-DD` (default current Kyiv month), `--write`
(persist the bonus report), `--publish` (send to Slack), `--check` (rates-vs-changelog
drift; can run standalone), `--format table`.

Flow:

1. Load: `field-verdict` report (settled statuses), `field-qa` report (participants),
   `rates.json`, and `published/<period>.json` (thread `ts` per date).
2. Resolve identities (Claude + `users.list`) → participants with `slackId` +
   `confidence`.
3. Compute per-day, per-person bonuses via `lib/fieldBonus.ts` (pure).
4. `--write`: persist `reports/field-bonus/<period>.{json,csv}`.
5. For each **SETTLED** day **not already notified** (per the idempotency log):
   - **Earned** (`ACCEPTED` / `ACCEPTED_EXCEPTION`): in `--publish`, reply in the day's
     verdict thread with the team breakdown, then DM each **confidently-resolved**
     participant their share; record each send in the notified log.
   - **No bonus** (`REJECTED` / `NEEDS_REVIEW` past grace): in `--publish`, post a
     short thread note with the reason; **no DM**; record the thread note in the log.
   - Dry-run (default): print the exact thread + DM text and the target users; send
     nothing.
6. Never act on `PENDING` days. Skip (with a warning) any settled day that
   `field-publish` hasn't posted yet (no thread to reply into).

### State & idempotency (the money-safety gate)

- `reports/field-bonus/<period>.json` — committed bonus report (lossless; the web
  render source; the audit trail incl. resolved identities + confidence).
- `reports/field-bonus/<period>.csv` — flat per-person-day record (intentionally lossy;
  no nested flags).
- `reports/field-bonus/rates.json` — the effective-dated rate table + `changelogMarker`.
- `reports/field-bonus/notified/<period>.json` — the **hard idempotency log**: the
  thread-post `ts` per date, and the DM `ts` + amount per `(date, slackId)`. A
  day/person is **never** notified twice. This is what makes the unattended cron safe.

Low-confidence identity → **skip the DM**, list the person in the thread + dry-run for a
human; never guess who gets paid.

### Web (two-interface requirement)

A read-only **Field Bonus** view: `GET /api/field-bonus?period=<key>` serves the
committed JSON (404 when absent), `?periods=1` lists committed periods. The page uses
the shared `usePeriodReport` hook (committed by default; current-month aware). It shows
per-day breakdowns, totals, flags, and notification status. No live/write path in the
browser — `reports/` is the CLI's job alone.

## Messaging

- **Thread breakdown** (in the day's verdict thread): team total + who earned what,
  with flags (e.g. ">2 paid participants", "unresolved: <initials>"), and an explicit
  **provisional** caveat (Ukrainian: "за день, до місячного коригування втрат бортів").
- **Personal DM**: each confidently-resolved participant gets only **their own** amount,
  the date, the components (base/early/weekend), the provisional caveat, and a pointer
  that payout requests go to the finance operator.
- Language: Ukrainian, matching the existing field-* messages.

## Rollout / cron

The daily rhythm is a pipeline: `slack-sync` → `field-qa --write` →
`field-verdict --write` → `field-publish --publish` → `field-bonus --publish`. No crons
exist in the repo today — this is greenfield infra (a GitHub Actions workflow is the
likely home).

**Manual-first:** ship the CLI and run it by hand (dry-run, then `--publish`) for ~a
week. Once identity resolution and amounts look reliable, enable the cron. The
idempotency log means the cron can run repeatedly without double-notifying.

## Testing

- `lib/bonusRates` — effective-date resolution (400 vs 700; assembler cutoff), drift
  detection.
- `lib/fieldBonus` — base/early/weekend math, soft >N-person flag, no-bonus settled
  days, rounding.
- Participant parsing from report text (`А+Т 14:30-18:30` → two participants + window).
- Notified-log idempotency gating (a second run sends nothing).
- Claude identity resolution mocked at the boundary.

## Risks / open questions

- **Identity resolution is Claude-driven end-to-end** (per decision). Mitigated by the
  confidence gate (low-confidence → no DM, human-flagged) and the audited, committed
  resolution. If misattribution proves common, fall back to a committed alias map.
- **The 2-person cap** is ambiguous; shipped as a soft flag, not an enforced drop.
- **Cron blast radius**: money messages firing unattended. Mitigated by idempotency +
  manual-first rollout + provisional wording + DMs being informational (not payment).
- **`field-qa` report-format variance**: free-text reports may not always carry a clean
  time window; days without a parseable window get no early-arrival bonus and are
  flagged for review rather than guessed.
