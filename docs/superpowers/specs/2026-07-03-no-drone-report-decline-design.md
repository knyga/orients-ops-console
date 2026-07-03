# Decline flight days with no drone-count report (verdict axis)

**Date:** 2026-07-03
**Status:** SUPERSEDED by `2026-07-03-unified-day-qualification-design.md` (operator-approved), which absorbs this axis into the unified verdict⇔bonus gate and changes the semantics to **immediate REJECTED** (no grace). Kept for the problem statement and the tooling-docs checklist; do not implement the PENDING-within-grace variant below.
**Builds on:** `2026-07-02-drone-counts-in-verdict-design.md` (per-person drone counts in verdict messages — structured extraction, `days[].droneReport`, the `🛸 Дрони:` line).

## Problem

The operator confirmed the business rule (2026-07-03): **#field-qa is the only source of drone-count information, and a flight day whose crew posted no drone-count report there pays no bonuses — a hard no-pay, not a reviewable gap.**

Today that rule lives only in the bonus path (`computeBonuses` voids the day, reason `no-drone-count`). The field-verdict — the team-facing per-day acceptance message — knows nothing about it: a day with perfect video + dataset but no drone report shows ✅ ACCEPTED while the bonus silently pays nothing. The published messages must tell the truth.

## Decision: verdict semantics for a missing drone report

**Chosen (recommended option): PENDING within grace → REJECTED after grace.**

- A **flight day** (the existing `flightDays` union: airborne reported, or a "Звіт" with a deployment window) with **no drone-count report** attributed to it:
  - **within the grace window** (existing `GRACE_WORKING_DAYS = 3`): `PENDING`, reason `no drone-count report in #field-qa`. Drone reports are same-day by design, but a late report that explicitly names the date still lands via `forDate` attribution — grace gives it room.
  - **after the grace window:** `REJECTED`, same reason. This is the first *machine* auto-reject besides an admin-declined dataset; it is deliberate — the operator's rule is hard no-pay, not "needs a human".
- **Approver override still outranks.** The existing resolutions overlay (`applyResolution`) runs after `verdictForDay`, so an approver `accepted_exception` (via the confirm-first instruction path) rescues an exceptional day. No new machinery.
- **Precedence:** any hard-fail wins. `datasetStatus === "DECLINED"` → REJECTED stays; missing-drone-report after grace also forces REJECTED even when video/dataset pass. Within grace, PENDING as usual.
- **Not gated:** days that did not fly (no bonus at stake), and dates absent from the field-qa report entirely (no verdict day exists — unchanged, the known 06-14 class of gap).

Alternatives considered: immediate REJECTED (strictest; punishes a one-day-late report that names its date), NEEDS_REVIEW only (contradicts the stated hard rule). If the operator prefers immediate REJECTED, the change is one conditional.

## Design

### 1. `verdictForDay` input + reason (`lib/fieldDayVerdict.ts`)

New optional input, threaded like `airborneReported`:

```ts
/** false when no drone-count report was attributed to this flight day. Defaults true (unknown → don't gate). */
droneReportPresent?: boolean;
```

- Default `true` so callers without drone data (old reports, tests) are unaffected.
- When `false` **and the day flew** (`airborneMinutes > 0 || !airborneReported`): push reason `"no drone-count report in #field-qa"`; status logic: within grace → PENDING (unless already REJECTED), after grace → REJECTED.
- `DayVerdict` carries `droneReportPresent: boolean` (echoed) alongside the `droneReport?: DroneEntry[]` passthrough from the base design.

### 2. `computeVerdicts` wiring (`lib/computeVerdicts.ts`)

The base design already lands `days[].droneReport: DroneEntry[]` on the committed field-qa report (extraction pass, Kyiv post-date + `forDate` attribution). `computeVerdicts` reads it per date and passes `droneReportPresent: (entries?.length ?? 0) > 0` into `verdictForDay`, copying `droneReport` onto the `DayVerdict`. **No Claude call added to the verdict pass** — extraction stays in the field-qa stage. If the committed field-qa report predates the drone extraction (no `droneReport` key anywhere), treat presence as unknown (`true`) and log — never mass-reject on missing data.

### 3. Ukrainian rendering (`lib/verdictPublish.ts`)

- `ukrainianGaps` gains the drone gap: `немає звіту про кількість дронів у #field-qa`.
- REJECTED render (exists for dataset-declines) covers the new reason via the same path; the `🛸 Дрони:` line (base design) appears only when a report exists, so a declined-for-no-report day never shows a drone line — consistent.

### 4. Published-message updates (operator-gated)

Recompute June (`field-qa --write` → `field-verdict --write`), then `npm run field-backfill` re-renders every published day from the current verdict report via `formatDayMessage` — picking up both the new `🛸 Дрони:` lines and any status flips (e.g. ACCEPTED → REJECTED for a no-report day). It already skips approver-overridden days. **DRY-RUN by default; the real `--publish --channel` run is the operator's call** — status flips are team-facing bad news and stay confirm-first.

### 5. Tooling docs (the "save in toolings" ask)

Write the rule where the tooling reads it:

- `CLAUDE.md`: the `field-verdict` and `field-bonus` bullets state the rule (#field-qa only source; no report → no pay; verdict PENDING→REJECTED after grace).
- `.claude/skills/field-bonus/SKILL.md` + `.claude/skills/bonus-report/SKILL.md`: same rule, phrased for the skill reader (missing report is a hard void, don't propose rescues except an explicit approver override).
- `lib/fieldDayVerdict.ts` doc comment: amend "never auto-rejected" to name the two hard-fails (admin-declined dataset, missing drone report after grace).

## Testing

- `verdictForDay`: flew + no report within grace → PENDING w/ reason; after grace → REJECTED; no-fly day ignores the flag; default `true` unchanged snapshots; precedence with dataset-declined.
- `computeVerdicts` wiring: presence derived from `days[].droneReport`; legacy report without the key → ungated + logged.
- `ukrainianGaps`/`formatDayMessage`: drone gap phrase; REJECTED text; no `🛸` line on no-report days.
- Backfill round-trip: status-flip day re-renders; overridden day skipped (existing tests extended).

## Out of scope

- Unifying `computeBonuses` onto `days[].droneReport` (still the follow-up from the base design; the bonus gate already enforces no-pay so behavior agrees even unmerged).
- Retroactive resolutions cleanup for June — the recompute + backfill covers it.
