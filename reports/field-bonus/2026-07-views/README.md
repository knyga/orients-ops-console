# Field-bonus payout report — July 2026

Period 2026-07-01..2026-07-31, regenerated 2026-08-13 from the committed
field-bonus report. Reflects the approver settlement wave of 2026-08-04 (07-10's
lost drone marked found → self-healed to ACCEPTED; 07-06 в.2 / 07-08 / 07-15 /
07-16 / 07-22 accepted as exceptions, 07-08 with a 4-person crew set; 07-12 /
07-14 / 07-17 / 07-27 explicitly rejected) **plus the 2026-08-13 drone-gate
effective-date fix** described below.
**Nearly settled: 3 pending rows, 700 ₴ at stake (07-31 airborne unrecorded).**
**Total to pay: 27 601 ₴** across 7 people; 27 counted / 7 rejected reports;
1 unrecovered drone loss (07-06 — within the >3 monthly limit, no team-zero, no
penalty multiplier).

Files here:

- `1-per-person.csv` — Report 1: totals per person (trips, early, weekend, gross, net).
- `2-per-member-detail.csv` — Report 2: every person's paid / excluded / rejected /
  unsettled report-days with pay + reasons, plus a TOTAL row per person.
- `3-per-day.csv` — Report 3: per Звіт (multi-report days carry the `report` ts) —
  status, crew, deploy/video minutes, per-person rate, split factor, day total.
- `4-crosscheck.json` — the reconciliation result (see below).

## What changed on 2026-08-13 (and why the total moved)

The per-person drone-count gate (spec 2026-07-28) was applying to the **whole**
of July, including dates before the rule existed. Until 2026-07-28 pilots
submitted drone counts collectively — one crew member posted the whole team's
tally — so author-based attribution carried no signal for those dates and the
gate unpaid people for breaking a rule that had not yet been announced. Two of
the affected days (07-13 в.2, 07-16) even had the pilot's own counts printed
inside a teammate's message.

The gate now binds only from `DRONE_GATE_EFFECTIVE_DATE` (`lib/droneOwners.ts`)
onward. Effect: **24 401 ₴ → 27 601 ₴**.

| Person | Was | Now | Δ |
|---|---|---|---|
| Андріан | 13 600 | **13 967** | +367 |
| Влад | 700 | **3 350** | +2 650 |
| Любомир | 1 367 | **2 750** | +1 383 |
| Данило | 3 067 | **2 317** | −750 |
| Сергій | 2 000 | **1 667** | −333 |
| Тарас | 1 867 | **1 750** | −117 |
| Надія | 1 800 | **1 800** | 0 |

Three people go **down**. That is the >2-crew split rule working as designed,
not a second bug: re-including a previously gated crew member divides that
Звіт's 2-person-sized pot among more people (07-04 now 3 ways at 667 instead of
2 at 1000; 07-06 в.2 3 ways at 600; 07-08 4 ways at 350). No July figure had
been sent to anyone — `outbound_messages` holds no `bonus` row for the period —
so nothing already promised to the team was withdrawn.

The two manual July eligibility corrections (07-02 Влад, 07-07 Любомир, both
noted «правило особистих звітів діє з 28.07») are now redundant but harmless —
an `eligibility: "counted"` override is idempotent.

## Report 1 — totals per person

| Person | Trips | Early | Weekend | Net (₴) |
|---|---|---|---|---|
| Андріан | 17 | 9 | 3 | **13 967** |
| Влад | 5 | 1 | 0 | **3 350** |
| Любомир | 4 | 3 | 0 | **2 750** |
| Данило | 4 | 1 | 1 | **2 317** |
| Надія | 2 | 2 | 0 | **1 800** |
| Сергій | 2 | 0 | 2 | **1 667** |
| Тарас | 3 | 0 | 0 | **1 750** |
| **Total** | 37 | 16 | 6 | **27 601** |

## Report 2 — per-member detail (summary; full data in the CSV)

- **Андріан — 13 967**: paid 07-01, 07-13 в.1, 07-15, 07-20, 07-21, 07-23,
  07-24, 07-29 (early, 900 each); 07-11, 07-18 (weekend, 1000 each); 07-03,
  07-09, 07-10, 07-16, 07-30 (700 each); 07-04 (split ⅔, 667); 07-06 в.2
  (split ⅔, 600). Rejected: 07-19, 07-28. Pending: 07-31 (700 at stake).
- **Влад — 3 350**: paid 07-02 (700), 07-13 в.2 (700), 07-16 (700), 07-23
  (early, 900), 07-08 (split ½, 350). Rejected: 07-01 в.2, 07-19.
- **Любомир — 2 750**: paid 07-07 (early, 900), 07-24 (early, 900), 07-06 в.2
  (split ⅔, 600), 07-08 (split ½, 350). Excluded: 07-30 (no own drone-count —
  the only remaining gate exclusion in July, and a legitimate one).
- **Данило — 2 317**: paid 07-02 (700), 07-04 (split ⅔, 667), 07-06 в.2
  (split ⅔, 600), 07-08 (split ½, 350).
- **Надія — 1 800**: paid 07-01, 07-07 (early, 900 each). Rejected: 07-01 в.2.
- **Сергій — 1 667**: paid 07-11 (weekend, 1000), 07-04 (split ⅔, 667).
- **Тарас — 1 750**: paid 07-03, 07-10 (700 each), 07-08 (split ½, 350).

## Report 3 — per-day payout

Full per-Звіт rows are in `3-per-day.csv`. Rejected (0 ₴): 07-01 в.2 (deploy
110m), 07-12, 07-14, 07-17, 07-27 (no-fly / no-video days, explicitly
rejected), 07-19 (deploy 140m + no airborne + no dataset), 07-28 (approver: no
drone report). Pending (700 ₴ at stake): 07-31 (airborne not recorded) + two
0-₴ rows (07-07 в.1, 07-11 в.2 — deploy window missing, nobody attributable).

## Cross-check — PASSED ✅

Verified by script (`4-crosscheck.json`):

- sum of per-person nets (Report 1) = **27 601** = canonical report `total`
- sum of day totals (Report 3) = **27 600** — 1 ₴ split-day rounding artifact
  (person nets round once at period level), within the documented ±1 ₴ tolerance
- every person's paid rows in Report 2 sum exactly to their canonical net —
  0 discrepancies across all 7 people
- exactly one `no_drone_count` flag survives for July (07-30, Любомир), all
  others were pre-effective-date and are now correctly exempt

Rate model: per person per counted Звіт = (700 + 200 early(≤12:30) + 300 weekend)
× splitFactor. Drone-gate per the 2026-07-28 spec **as amended 2026-08-13**
(effective-date cutoff); loss handling per the 2026-08-04 spec (07-10 self-healed
on «борт знайшли», 07-06 в.2 accepted by explicit approver exception).
