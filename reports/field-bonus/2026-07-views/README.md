# Field-bonus payout report — July 2026

Period 2026-07-01..2026-07-31, computed 2026-08-04 from the committed field-bonus
report (unified verdict gate, incl. the 2026-08-04 unrecovered-loss reject rule;
refreshed after the approver acceptances of 07-05 / 07-13 в.1 / 07-25).
**NOT fully settled: 10 pending/review rows, 3 700 ₴ still at stake.**
**Total to pay (settled): 18 200 ₴** across 7 people; 19 counted / 5 rejected
reports; 2 unrecovered drone losses (within the >3 monthly limit — no team-zero,
no penalty multiplier).

Files here:

- `1-per-person.csv` — Report 1: totals per person (trips, early, weekend, gross, net).
- `2-per-member-detail.csv` — Report 2: every person's paid / excluded / rejected /
  unsettled report-days with pay + reasons, plus a TOTAL row per person.
- `3-per-day.csv` — Report 3: per Звіт (multi-report days carry the `report` ts) —
  status, crew, deploy/video minutes, per-person rate, split factor, day total.
- `4-crosscheck.json` — the reconciliation result (see below).

## Report 1 — totals per person

| Person | Trips | Early | Weekend | Net (₴) |
|---|---|---|---|---|
| Андріан | 12 | 7 | 2 | **10 400** |
| Сергій | 2 | 0 | 2 | **2 000** |
| Надія | 2 | 2 | 0 | **1 800** |
| Данило | 2 | 0 | 1 | **1 700** |
| Любомир | 1 | 1 | 0 | **900** |
| Влад | 1 | 0 | 0 | **700** |
| Тарас | 1 | 0 | 0 | **700** |
| **Total** | 21 | 10 | 5 | **18 200** |

## Report 2 — per-member detail (summary; full data in the CSV)

- **Андріан — 10 400**: paid 07-01, 07-13 в.1 (exception), 07-20, 07-21, 07-23,
  07-24, 07-29 (early, 900 each); 07-11, 07-18 (exception) (weekend, 1000 each);
  07-03, 07-09, 07-30 (700 each). Excluded: 07-04 (drone gate). Rejected: 07-06
  в.2 + 07-10 (drone lost, not recovered), 07-19, 07-28. Pending: 07-15, 07-16,
  07-31.
- **Сергій — 2 000**: paid 07-04 (weekend exception), 07-11 (weekend) — 1000 each.
- **Надія — 1 800**: paid 07-01, 07-07 (early, 900 each). Rejected: 07-01 в.2
  (deploy 110m < 3h).
- **Данило — 1 700**: paid 07-02 (700), 07-04 (weekend exception, 1000).
  Rejected: 07-06 в.2 (drone lost).
- **Любомир — 900**: paid 07-07 (early; restored by approver eligibility
  correction). Excluded: 07-24, 07-30 (no own drone-count). Rejected: 07-06 в.2.
- **Влад — 700**: paid 07-02 (restored by eligibility correction). Excluded:
  07-23 (no own drone count). Rejected: 07-01 в.2, 07-19. Pending: 07-13 в.2,
  07-16.
- **Тарас — 700**: paid 07-03. Rejected: 07-10 (drone lost, not recovered).

## Report 3 — per-day payout (summary; full data in the CSV)

Paid reports: 07-01 (1800), 07-02 (1400), 07-03 (1400), 07-04 (2000, exception),
07-07 (1800), 07-09 (700), 07-11 (2000), 07-13 в.1 (900, exception), 07-18
(1000, exception), 07-20 (900), 07-21 (900), 07-23 (900), 07-24 (900), 07-29
(900), 07-30 (700).
Counted but 0 ₴: 07-02 в.2, 07-05, 07-25, 07-26 (exceptions with empty crew —
accepted days, nobody attributable to pay).

Rejected (0 ₴): 07-01 в.2 (deploy 110m), 07-06 в.2 + 07-10 (**drone lost and
not recovered** — the 2026-08-04 rule), 07-19 (deploy 140m + no airborne + no
dataset), 07-28 (approver: no drone report).

Pending/review (3 700 ₴ at stake): 07-13 в.2 (Влад, video 37%), 07-15 (video
42%), 07-16 (video 10%), 07-31 (airborne not recorded) + no-Звіт flight days
07-08, 07-22 and other 0-₴-attributable rows.

## Cross-check — PASSED ✅

Verified by script (`4-crosscheck.json`):

- sum of per-person nets (Report 1) = **18 200**
- sum of day totals (Report 3) = **18 200**
- canonical report `total` = **18 200**
- per-person trips/early/weekend/net re-derived from `days[]` match the
  canonical `people[]` for all 7 people — 0 discrepancies.

Rate model: per person per counted Звіт = (700 + 200 early(≤12:30) + 300 weekend)
× splitFactor (all 1 this month). Drone-gate exclusions and approver corrections
per the per-pilot drone-count spec (2026-07-28); unrecovered-loss rejections per
the 2026-08-04 spec.
