# Field-bonus payout report — August 2026

Period 2026-08-01..2026-08-31, generated 2026-09-02 (~21:00 Kyiv) from the
field-bonus report (`npm run field-bonus -- --start 2026-08-01 --end 2026-08-31
--write`, persisted to the `reports` table, feature `field-bonus`, period
`2026-08`), after the Звіт date-header parser fix, a full `field-verdict --write`
recompute, and the approver's Slack pass of 2026-09-02 evening.

**Total to pay now: 14 700 ₴** across 5 people; 17 counted Звіти, 2 rejected;
no drone loss recorded (no team-zero, no penalty multiplier).

**Not yet final.** Two things still hold back money:

- **9 800 ₴ withheld by the per-person drone-count gate** on ACCEPTED days
  (11 exclusions; each cross-checked against `field-qa` `droneSubmitters` — the
  excluded person posted no own drone-count message that day). Only an approver
  `eligibility: counted` correction pays these.
- **6 000 ₴ at stake on 3 unsettled Звіти** (08-13, 08-27, 08-30) — each needs
  an approver decision (08-30 leaves its grace window on 09-03).

Files here:

- `1-per-person.csv` — Report 1: totals per person (trips, early, weekend, gross, net).
- `2-per-member-detail.csv` — Report 2: every person's paid / excluded / rejected /
  unsettled report-days with pay + reasons, plus a TOTAL row per person.
- `3-per-day.csv` — Report 3: per Звіт — status, crew, deploy/video minutes,
  per-person rate, split factor, day total. No-fly days are included (0 ₴).
- `4-crosscheck.json` — the reconciliation result (see below).

## What changed on 2026-09-02 (4 200 ₴ → 14 700 ₴)

1. **Parser bug** (`lib/fieldReports.ts`): the Звіт header regex accepted only
   `DD.MM.YYYY`. Eight August reports were written as `08.08.26`, `13.08`,
   `24.08:`, `2026.08.26` or the typo `28.08.2028` and were silently dropped, so
   those days showed as «flight detected but no Звіт». Fixed: two-digit years,
   yearless headers (year inferred from the Slack posting date, Kyiv), reversed
   `YYYY.MM.DD`, and a future-year typo clamped to the posting year. Yearless
   dates must be the whole header line, so the bot's own «🛸 Звіт по дронах за
   18.08» reminder is not mistaken for a report.
2. **Nightly froze late-August** (`lib/runNightly.ts`): from the 1st of a month the
   nightly reused the previous month's committed verdict instead of recomputing.
   The 08-31 run stored 08-26..08-30 as PENDING (still inside the 3-working-day
   grace), and that snapshot never flipped to NEEDS_REVIEW / never posted. Fixed:
   a committed verdict with any PENDING day gets a fresh extract + recompute.
3. **Proposal supersede bug** (`lib/proposals.ts`, `lib/applyInstructionReply.ts`):
   a second instruction in a verdict thread killed every pending proposal, not
   just the same-axis one — 08-08's «прийняти день» was lost to the crew fix that
   followed it. Fixed: proposals stack per axis, one «так» applies them all.
4. Approver decisions applied in Slack on 2026-09-02 evening: 08-01, 08-08, 08-12,
   08-21, 08-24 accepted as exceptions; 08-05 and 08-07 **rejected** (no crew
   recorded — the 07.08 «повні польові дні» note was withdrawn); 08-06 accepted
   with crew Андріан; crews set for 08-08 (Влад+Сергій), 08-10 (Влад+Данило),
   08-24 (Любомир+Влад).

## Report 1 — totals per person

| Person | Trips | Early | Weekend | Net (₴) |
|---|---|---|---|---|
| Влад | 8 | 2 | 2 | **6 600** |
| Андріан | 7 | 4 | 0 | **5 700** |
| Сергій | 1 | 0 | 1 | **1 000** |
| Данило | 1 | 0 | 0 | **700** |
| Любомир | 1 | 0 | 0 | **700** |
| **Total** | 18 | 6 | 3 | **14 700** |

## Report 2 — per-member detail

- **Влад — 6 600**: paid 08-08 (weekend, 1000), 08-10 (700), 08-19 (700), 08-20
  (early, 900), 08-24 (700), 08-26 (early, 900), 08-28 (700), 08-29 (weekend,
  1000). Gate-excluded: 08-01 (weekend, 1000), 08-12 (early, 900), 08-21 (early,
  900), 08-25 (700). Unsettled: 08-13, 08-27, 08-30.
- **Андріан — 5 700**: paid 08-06 (700), 08-12 (early, 900), 08-19 (700), 08-20
  (early, 900), 08-21 (early, 900), 08-26 (early, 900), 08-28 (700).
  Gate-excluded: 08-04 (700), 08-18 (early, 900), 08-22 (weekend, 1000), 08-23
  (weekend, 1000), 08-25 (700), 08-29 (weekend, 1000) — 5 300 ₴. Unsettled:
  08-13, 08-27, 08-30.
- **Сергій — 1 000**: paid 08-08 (weekend, 1000).
- **Данило — 700**: paid 08-10 (700).
- **Любомир — 700**: paid 08-24 (700). Gate-excluded: 08-01 (weekend, 1000).

## Report 3 — per-day payout (Звіти only; full rows incl. no-fly days in the CSV)

| Date | Status | Crew | Deploy | Video | Rate | Paid to | Day total |
|---|---|---|---|---|---|---|---|
| 08-01 Sat | ACCEPTED_EXCEPTION | Любомир + Влад | 90 | 0 | 1 000 | — (gate, both) | 0 |
| 08-04 | ACCEPTED_EXCEPTION | Андріан | 180 | 18.8 | 700 | — (gate) | 0 |
| 08-05 | REJECTED | — | — | 0 | 0 | — | 0 (approver: no crew) |
| 08-06 | ACCEPTED_EXCEPTION | Андріан | — | 0 | 700 | Андріан | 700 |
| 08-07 | REJECTED | — | — | 58.1 | 0 | — | 0 (approver: no crew) |
| 08-08 Sat | ACCEPTED_EXCEPTION | Влад + Сергій | 190 | 0 | 1 000 | both | 2 000 |
| 08-10 | ACCEPTED_EXCEPTION | Влад + Данило | 365 | 0 | 700 | both | 1 400 |
| 08-12 | ACCEPTED_EXCEPTION | Андріан + Влад | 290 | 24 | 900 | Андріан | 900 |
| 08-13 | NEEDS_REVIEW | Андріан + Влад | 300 | 71.6 | 0 | — | 0 (0 airborne) |
| 08-18 | ACCEPTED | Андріан | 350 | 75.1 | 900 | — (gate) | 0 |
| 08-19 | ACCEPTED | Андріан + Влад | 225 | 100.4 | 700 | both | 1 400 |
| 08-20 | ACCEPTED | Андріан + Влад | 335 | 119.9 | 900 | both | 1 800 |
| 08-21 | ACCEPTED_EXCEPTION | Андріан + Влад | 190 | 26.2 | 900 | Андріан | 900 |
| 08-22 Sat | ACCEPTED | Андріан | 255 | 83.4 | 1 000 | — (gate) | 0 |
| 08-23 Sun | ACCEPTED | Андріан | 240 | 128.7 | 1 000 | — (gate) | 0 |
| 08-24 | ACCEPTED | Любомир + Влад | 220 | 50.9 | 700 | both | 1 400 |
| 08-25 | ACCEPTED | Андріан + Влад | 215 | 73 | 700 | — (gate, both) | 0 |
| 08-26 | ACCEPTED | Андріан + Влад | 240 | 111.5 | 900 | both | 1 800 |
| 08-27 | NEEDS_REVIEW | Андріан + Влад | 390 | 118.6 | 0 | — | 0 (airborne not recorded) |
| 08-28 | ACCEPTED | Андріан + Влад | 330 | 123.5 | 700 | both | 1 400 |
| 08-29 Sat | ACCEPTED | Андріан + Влад | 180 | 33.2 | 1 000 | Влад | 1 000 |
| 08-30 Sun | PENDING | Андріан + Влад | 225 | 65.4 | 0 | — | 0 (0 airborne) |

Other August dates: no Звіт (no-fly, or telemetry without a report — 08-03,
08-31), nobody attributable, 0 ₴. 08-11 carries an unconfirmed «прийняти»
proposal from 08-16 (no-fly, no crew — nothing at stake).

## Cross-check — PASSED ✅

Verified by script (`4-crosscheck.json`):

- sum of per-person nets (Report 1) = **14 700** = canonical report `total`
- sum of day totals (Report 3) = **14 700** — 0 ₴ rounding delta (no split days)
- per-person trips/early/weekend/net re-derived from `days[]` match `people[]`
  exactly for all five people
- 11 `no_drone_count` flags, all on/after the 2026-07-28 effective date.

Rate model: per person per counted Звіт = (700 + 200 early(≤12:30) + 300 weekend)
× splitFactor (all August Звіти ≤2 crew → splitFactor 1).
