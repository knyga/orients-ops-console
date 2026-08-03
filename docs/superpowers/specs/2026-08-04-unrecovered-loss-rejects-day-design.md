# Unrecovered drone loss machine-rejects the Звіт

**Date:** 2026-08-04 · **Status:** approved (Oleksandr K) · **Effective:** July 2026 onward (whole-month recompute, no date cutoff)

## Policy

«Не платимо бонуси в день втрати борта»: a Звіт whose loss-ledger record is
`lost && !found` is a machine **REJECTED** — same hard-fail class as
deployment < 3h or an admin-declined dataset. No pay for that report's crew.

- **Found loss is exempt.** `lost && found` (e.g. 2026-07-04, 2026-07-11) has
  no verdict effect — the day pays normally. «Борт знайшли» (approver verdict-
  thread reply, agent DM `field_loss_set`, or `field-instructions --loss found`)
  updates the ledger, and the next recompute flips the rejection back
  automatically — self-healing, no manual re-accept needed.
- **Approver escape hatch unchanged:** an explicit `accepted_exception`
  resolution (day `--accept`) outranks the machine reject via the existing
  `applyResolution` path, exactly like the deploy-short override.
- The monthly team cutoff (>3 unrecovered losses zero the whole period) and the
  crew penalty multiplier stay separate and unchanged.

## Mechanics

- `lib/fieldDayVerdict.ts`: `VerdictInput` gains `loss?: { lost: boolean;
  found: boolean }`. `verdictForDay` treats `loss.lost && !loss.found` as a
  hard fail: reason `drone lost and not recovered`, status joins the REJECTED
  branch (`datasetStatus === "DECLINED" || deployShort || unrecoveredLoss`).
- `lib/computeVerdicts.ts`: already fetches `lossForVerdict(lossRows, date,
  reportTs)` per report — the value moves from display-only attach to a
  `verdictForDay` input (still attached to the row for the 🛸/⚠️ render).
- Publish: the rejected message posts ⛔ «відхилено» via the existing nightly
  auto-post; the loss line (`⚠️ Втрата борта`) already renders. Ukrainian
  reason at post time mirrors the English report reason.
- Downstream zero-change: field-bonus routes REJECTED reports to `voidedDays`
  (existing unified gate); web/CLI render `reasons` as-is.

## Tests (`lib/fieldDayVerdict.test.ts`)

1. unrecovered loss on an otherwise-passing day → REJECTED with the new reason;
2. found loss → verdict unchanged;
3. unrecovered loss + `accepted_exception` resolution → ACCEPTED_EXCEPTION
   (existing `applyResolution` precedence, covered where resolutions are tested).

## July impact

2026-07-10 (Андріан, Тарас) ACCEPTED → REJECTED: −1 400 ₴, period total
18 700 → 17 300 ₴. 2026-07-06 stays NEEDS_REVIEW (gains the loss reason).
2026-07-04 / 2026-07-11 untouched (found).
