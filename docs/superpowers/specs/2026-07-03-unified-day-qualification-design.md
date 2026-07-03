# Unified flight-day qualification: verdict «прийнято» ⇔ bonus pays

**Date:** 2026-07-03
**Status:** Design approved by the operator (brainstormed interactively; all semantic decisions below are the operator's).
**Builds on:** `2026-07-02-drone-counts-in-verdict-design.md` (structured drone-count extraction, `days[].droneReport`) and **supersedes the status-semantics choice** in `2026-07-03-no-drone-report-decline-design.md` (grace-then-reject → immediate reject, per the operator).

## Problem

The published verdict for 2026-06-30 read «✅ прийнято» while the bonus path paid the crew nothing (deployment 2h < 3h). The operator's rule: **«прийнято» means the crew gets bonuses for that day.** Today two rule systems disagree in *both* directions:

| Axis | Verdict gate (`lib/fieldDayVerdict.ts`) | Bonus gate (`lib/fieldBonus.ts`) |
|---|---|---|
| Video | ≥ 50% of airborne | ≥ 2 min absolute |
| Deployment ≥ 3h | not checked (display only) | required |
| Drone-count report | not checked (in-flight design adds it) | required |
| Dataset notice | required | not checked |

So a verdict-ACCEPTED day can pay nothing (06-01, 06-16, 06-30) and a verdict-flagged day can pay (06-26, 06-27). The two paths don't even share a day model: verdict days come from the airborne extraction, bonus days from the Звіт parse (06-26 has 0 extracted airborne minutes but a 200-min deploy window).

## Operator decisions

1. **Full unification** — one qualification predicate behind both the verdict and the pay; «прийнято» ⇔ pays, and a flagged/rejected day never pays.
2. **Video rule** — video ≥ max(2 min, 50% × airborne). Airborne unknown → the day cannot auto-qualify (human review).
3. **Pay timing** — only settled days (ACCEPTED / ACCEPTED_EXCEPTION) pay. PENDING / NEEDS_REVIEW days are listed with the amount at stake, not paid.
4. **Hard fails auto-reject immediately** (no grace), with the admin able to change any decision via the existing confirm-first approver-instruction path.

## Design

### 1. The gate — `verdictForDay` (`lib/fieldDayVerdict.ts`)

A flight day is **ACCEPTED** iff all four axes pass:

1. **Deployment ≥ 3h** (`MIN_DEPLOY_MIN = 180`, moved/re-exported from `lib/fieldBonus.ts`) — from the Звіт deploy window.
2. **Video ≥ max(2 min, MIN_RATIO × airborne)** — `MIN_VIDEO_MIN = 2` becomes an absolute floor on top of the existing 50% rule.
3. **Drone-count report present** for the day (`droneReportPresent`, from `days[].droneReport` per the 07-02 design).
4. **Dataset** POSTED or WAIVED.

Failure handling splits by finality:

- **Hard fail → immediate REJECTED** (machine auto-reject): deploy window known and `deployMin < 180`; `droneReportPresent === false`; `datasetStatus === "DECLINED"` (existing). Reasons: `"deployment <deployMin>m is under 3h"`, `"no drone-count report in #field-qa"`. A late drone report that names its date flips the day back on the next recompute (attribution via `forDate`).
- **Curable gap → PENDING within grace → NEEDS_REVIEW after** (existing lifecycle, unchanged): video below the gate, dataset MISSING, airborne not quantified (`airborneReported === false` or ratio null), deploy window absent/unparsed (`deployMin == null` — a parse gap is not proof the crew was short), and **no Звіт at all** (airborne/video activity with no crew/deploy attribution — new reason `"flight detected but no Звіт (crew/deployment unknown)"`; such a day can never auto-accept because nobody is attributable to pay).
- **Approver resolutions outrank everything** — the existing `applyResolution` overlay runs after `verdictForDay`; ACCEPTED_EXCEPTION / REJECTED overrides are untouched. This is the admin escape hatch for wrong auto-rejects.

New `VerdictInput` fields (all optional, defaulting to today's behavior so legacy callers/tests are unaffected): `deployMin?: number | null`, `droneReportPresent?: boolean` (default `true` = don't gate), `hasZvit?: boolean` (default `true`). `DayVerdict` echoes `deployMin` and `droneReportPresent` and keeps the `droneReport?: DroneEntry[]` passthrough.

### 2. Wiring — `computeVerdicts` (`lib/computeVerdicts.ts`)

- The day model already unions airborne-extraction days and Звіт days; it now threads `deployMin` (from the Звіт parse, same source the bonus used), `droneReportPresent` (`(days[].droneReport?.length ?? 0) > 0`), and `hasZvit` per date into `verdictForDay`.
- If the committed field-qa report predates drone extraction (no `droneReport` key on any day), treat presence as unknown (`true`) and log — never mass-reject on missing data (carried over from the 07-03 doc).
- No Claude call is added to the verdict pass; extraction stays in the field-qa stage.

### 3. Bonus becomes a pure consumer — `computeBonuses` / `lib/fieldBonus.ts`

- `computeBonuses` no longer evaluates gates. Input becomes the **resolved verdict days** (post-`applyResolution`) plus the Звіт metadata it still needs (start time for the early bonus). The bonus CLI/API computes verdicts in-process (it already requires `POSTGRES_URL` + `ANTHROPIC_API_KEY` + `VIMEO_TOKEN`), so `npm run field-bonus` stays standalone.
- A day **pays** iff `status ∈ {ACCEPTED, ACCEPTED_EXCEPTION}`: 700/trip + 200 early (Звіт start ≤ 12:30) + 300 weekend, then the drone-loss multiplier and >3-loss team cutoff — all money math unchanged.
- **New `pendingDays[]`** on `BonusReport`: PENDING / NEEDS_REVIEW days with `{ date, roster, status, reasons, amountAtStake }` (the gross the crew would earn if accepted). Not counted in `total`.
- `voidedDays[]` now carries every REJECTED day with the verdict reason (superset of today's `no-drone-count`-only list).
- The duplicate live `classifyDroneCount` call in `lib/computeBonuses.ts` is **deleted** — the drone gate now flows through the verdict from `days[].droneReport` (completing the 07-02 design's deferred follow-up).
- Per-person eligibility corrections (`applyRosterCorrection` `perPerson`) still apply bonus-side; day-level roster is taken from the verdict (which already applies roster corrections), so crew resolution happens once.

### 4. Rendering & surfaces

- `lib/verdictPublish.ts` `ukrainianGaps` gains: «виїзд коротший за 3 год (X хв)», «немає звіту про кількість дронів у #field-qa», «відео X хв — менше 2 хв», «політ зафіксовано, але немає Звіту (екіпаж невідомий)». REJECTED days render via the existing «відхилено» path; the `🛸 Дрони:` line appears only when a report exists (region discipline per the 07-02 design).
- Bonus JSON/CSV/web (`app/(dashboard)/field-bonus/`, `scripts/field-bonus.ts`) render the pending section; the CSV gains `status` on day rows and a `pending` block (flat, lossy is fine).
- Docs: CLAUDE.md `field-verdict`/`field-bonus` bullets, `.claude/skills/field-bonus/SKILL.md`, `.claude/skills/bonus-report/SKILL.md` state the invariant **ACCEPTED ⇔ pays** and the four axes; `lib/fieldDayVerdict.ts` doc comment lists the three machine auto-rejects (declined dataset, short deploy, missing drone report).

### 5. Lifecycle, nightly, and historical messages

- The nightly pipeline recomputes verdicts as usual; new-data flips (e.g. a late drone report) land automatically for unpublished days.
- Already-published days whose status flips are re-rendered via `field-backfill` (re-renders from the current verdict report through `formatDayMessage`, skips approver-overridden days). **DRY-RUN by default; the real `--publish --channel` run is the operator's call** — status flips are team-facing bad news and stay confirm-first.

### 6. June 2026 retro impact (expected after recompute)

*(Baseline: June total 20 500 ₴ after the 07-03 `forDate` attribution fix (`e3c4e5d`) un-voided 06-01 — its drone report was a lagged post naming 01.06.)*

- ACCEPTED → **REJECTED**: 06-30 (deploy 120m < 3h; was never paid, so no money change).
- ACCEPTED → **NEEDS_REVIEW**: 06-03 (no Звіт), 06-16 (Звіт without a deploy window).
- Paid → **pending**: 06-26 (0 extracted airborne vs 200-min deploy — contradictory data), 06-27 (dataset MISSING) — June `total` drops 20 500 → 17 100 ₴ until an approver settles those two.
- The remaining 11 counted days (06-01, 02, 05, 06, 10, 13, 15, 17, 18, 19, 29) pass all four axes and keep paying.
- The June end-to-end test snapshot asserts exactly this table.

## Testing

- `verdictForDay`: each axis failing alone; hard-vs-curable precedence (short deploy + missing video → REJECTED, not PENDING); defaults leave legacy snapshots unchanged; override rescues a hard reject; the 2-min floor binds when 50% passes (airborne 2m, video 1.5m).
- `computeBonuses`: pays only ACCEPTED/ACCEPTED_EXCEPTION; pending section contents + `amountAtStake`; money-math regression on existing fixtures; per-person eligibility overrides still honored.
- Rendering: new Ukrainian gap phrases; REJECTED message for a short-deploy day; region round-trips (`splitRosterSuffix`) with the 🛸 line.
- End-to-end June snapshot per §6.

## Out of scope

- Any change to the money model (700/200/300, multiplier, team cutoff).
- Retroactive Slack edits themselves (operator runs `field-backfill -- --publish` when ready).
- People-registry resolution of drone-report names (07-02 decision stands: as written).
