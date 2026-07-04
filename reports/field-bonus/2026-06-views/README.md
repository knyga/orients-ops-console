# Field-bonus payout report — June 2026 (settled)

Period 2026-06-01..2026-06-30, computed 2026-07-04 from the committed field-bonus
report (unified verdict gate). **Fully settled: 0 pending days.**
**Total to pay: 25 300 ₴** across 8 people; 16 counted / 13 rejected flight days;
1 unrecovered drone loss (within limits — no penalty, no team-zero).

Files here:

- `1-per-person.csv` — Report 1: totals per person (trips, early, weekend, gross, net).
- `2-per-member-detail.csv` — Report 2: every person's paid days (with pay + which
  bonuses) and rejected days (with reasons), plus a TOTAL row per person.
- `3-per-day.csv` — Report 3: per flight day — status, crew, deploy/video minutes,
  per-person rate, day total; rejected days carry the reason.
- `4-crosscheck.json` — the reconciliation result (see below).

## Report 1 — totals per person

| Person | Trips | Early | Weekend | Net (₴) |
|---|---|---|---|---|
| Андріан | 14 | 3 | 4 | **11 600** |
| Надія | 4 | 2 | 0 | **3 200** |
| Данило | 4 | 0 | 1 | **3 100** |
| Сергій | 3 | 0 | 3 | **3 000** |
| Любомир | 2 | 0 | 0 | **1 400** |
| Тарас | 2 | 0 | 0 | **1 400** |
| Влад | 1 | 1 | 0 | **900** |
| Володимир | 1 | 0 | 0 | **700** |
| **Total** | 31 | 6 | 8 | **25 300** |

## Report 2 — per-member detail (summary; full data in the CSV)

- **Андріан — 11 600**: paid 06-02, 06-05, 06-29 (early, 900 each); 06-06, 06-13,
  06-21, 06-27 (weekend, 1000 each); 06-10, 06-15, 06-16, 06-17, 06-18, 06-19 (solo),
  06-26 (700 each). Rejected: 06-20 (drones didn't fly).
- **Надія — 3 200**: paid 06-02, 06-05 (early, 900); 06-16, 06-26 (700).
  Rejected: 06-09, 06-11 (no video / dataset declined).
- **Данило — 3 100**: paid 06-06 (weekend, 1000); 06-10, 06-15, 06-18 (700).
  Rejected: 06-12, 06-23 (no video).
- **Сергій — 3 000**: paid 06-13, 06-21, 06-27 (all weekend, 1000).
  Rejected: 06-20 (drones didn't fly).
- **Любомир — 1 400**: paid 06-01, 06-04 (700). Rejected: 06-03, 06-09, 06-11,
  06-12, 06-22 (no Звіт / no video), 06-30 (deploy < 3h).
- **Тарас — 1 400**: paid 06-01, 06-17 (700). Rejected: 06-03, 06-24.
- **Влад — 900**: paid 06-29 (early, 900). Rejected: 06-22, 06-23, 06-24, 06-25
  (no video / no Звіт), 06-30 (deploy < 3h).
- **Володимир — 700**: paid 06-04 (700). Rejected: none.

## Report 3 — per-day payout (summary; full data in the CSV)

Paid days: 06-01 (1400), 06-02 (1800), 06-04 (1400, exception), 06-05 (1800),
06-06 (2000), 06-10 (1400), 06-13 (2000), 06-15 (1400), 06-16 (1400, exception),
06-17 (1400), 06-18 (1400), 06-19 (700, solo), 06-21 (2000, exception),
06-26 (1400, exception), 06-27 (2000), 06-29 (1800).

Rejected (0 ₴): 06-03, 06-07, 06-08, 06-09, 06-11, 06-12, 06-20, 06-22, 06-23,
06-24, 06-25, 06-28 (no Звіт / no video / no flights / dataset declined — all with
explicit approver rejection), 06-30 (deployment 2h, under the 3h gate).
06-14 had no flight activity at all.

## Cross-check — PASSED ✅

Verified by script (`4-crosscheck.json`):

- sum of per-person nets (Report 1) = **25 300**
- sum of per-member paid days (Report 2) = **25 300** — re-derived
  trips/early/weekend/net match the canonical `people[]` for all 8 people
- sum of day totals (Report 3) = **25 300**
- canonical report `total` = **25 300**

0 discrepancies. Rate model: per person per counted day = 700 + 200 (early ≤12:30)
+ 300 (weekend); no drone-loss penalty this period.
