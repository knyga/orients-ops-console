# Field-bonus payout report — July 2026

Period 2026-07-01..2026-07-31, computed 2026-08-04 from the committed field-bonus
report (unified verdict gate incl. the 2026-08-04 unrecovered-loss rule). Reflects
the full approver settlement wave of 2026-08-04: 07-10's lost drone marked found
(self-healed to ACCEPTED), 07-06 в.2 / 07-08 / 07-15 / 07-16 / 07-22 accepted as
exceptions (07-08 with a 4-person crew set), 07-12 / 07-14 / 07-17 / 07-27
explicitly rejected.
**Nearly settled: 3 pending rows, 700 ₴ at stake (07-31 airborne unrecorded).**
**Total to pay: 24 401 ₴** across 7 people; 27 counted / 7 rejected reports;
1 unrecovered drone loss (07-06 — within the >3 monthly limit, no team-zero, no
penalty multiplier).

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
| Андріан | 16 | 9 | 2 | **13 600** |
| Данило | 4 | 1 | 1 | **3 067** |
| Сергій | 2 | 0 | 2 | **2 000** |
| Тарас | 3 | 0 | 0 | **1 867** |
| Надія | 2 | 2 | 0 | **1 800** |
| Любомир | 2 | 1 | 0 | **1 367** |
| Влад | 1 | 0 | 0 | **700** |
| **Total** | 30 | 13 | 5 | **24 401** |

## Report 2 — per-member detail (summary; full data in the CSV)

- **Андріан — 13 600**: paid 07-01, 07-06 в.2 (exception), 07-13 в.1
  (exception), 07-15 (exception), 07-20, 07-21, 07-23, 07-24, 07-29 (early, 900
  each); 07-11, 07-18 (exception) (weekend, 1000 each); 07-03, 07-09, 07-10,
  07-16 (exception), 07-30 (700 each). Excluded: 07-04 (drone gate). Rejected:
  07-19, 07-28. Pending: 07-31 (700 at stake).
- **Данило — 3 067**: paid 07-02 (700), 07-04 (weekend exception, 1000),
  07-06 в.2 (early exception, 900), 07-08 (exception, split ⅔, 467).
- **Сергій — 2 000**: paid 07-04 (weekend exception), 07-11 (weekend) — 1000 each.
- **Тарас — 1 867**: paid 07-03, 07-10 (700 each), 07-08 (split ⅔, 467).
- **Надія — 1 800**: paid 07-01, 07-07 (early, 900 each). Rejected: 07-01 в.2.
- **Любомир — 1 367**: paid 07-07 (early, 900; restored by eligibility
  correction), 07-08 (split ⅔, 467). Excluded: 07-06 в.2, 07-24, 07-30 (no own
  drone-count).
- **Влад — 700**: paid 07-02 (restored by eligibility correction). Excluded:
  07-08, 07-13 в.2, 07-16, 07-23 (no own drone-count). Rejected: 07-01 в.2, 07-19.

## Report 3 — per-day payout (summary; full data in the CSV)

Paid reports: 07-01 (1800), 07-02 (1400), 07-03 (1400), 07-04 (2000), 07-06 в.2
(1800), 07-07 (1800), 07-08 (1400, 3×467 split ⅔), 07-09 (700), 07-10 (1400),
07-11 (2000), 07-13 в.1 (900), 07-15 (900), 07-16 (700), 07-18 (1000), 07-20
(900), 07-21 (900), 07-23 (900), 07-24 (900), 07-29 (900), 07-30 (700).
Counted but 0 ₴: 07-02 в.2, 07-05, 07-06 в.1, 07-13 в.2 (Влад drone-gated),
07-22, 07-25, 07-26 (exceptions with empty/fully-gated crew).

Rejected (0 ₴): 07-01 в.2 (deploy 110m), 07-12, 07-14, 07-17, 07-27 (no-fly /
no-video days, explicitly rejected), 07-19 (deploy 140m + no airborne + no
dataset), 07-28 (approver: no drone report).

Pending (700 ₴ at stake): 07-31 (airborne not recorded) + two 0-₴ rows
(07-07 в.1, 07-11 в.2 — deploy window missing, nobody attributable).

## Cross-check — PASSED ✅

Verified by script (`4-crosscheck.json`):

- sum of per-person nets (Report 1) = **24 401** = canonical report `total`
- sum of day totals (Report 3) = **24 400** — 1 ₴ split-day rounding artifact
  (07-08 pays 3 × 466.67; person nets round once at period level), within the
  documented ±1 ₴ tolerance
- per-person trips/early/weekend/net re-derived from `days[]` match the
  canonical `people[]` for all 7 people — 0 discrepancies.

Rate model: per person per counted Звіт = (700 + 200 early(≤12:30) + 300 weekend)
× splitFactor (⅔ on 07-08, else 1). Drone-gate exclusions per the per-pilot
drone-count spec (2026-07-28); loss handling per the 2026-08-04 spec (07-10
self-healed on «борт знайшли», 07-06 в.2 accepted by explicit approver exception).
