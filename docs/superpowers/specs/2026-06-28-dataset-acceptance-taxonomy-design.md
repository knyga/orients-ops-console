# Dataset Acceptance Taxonomy — Design

**Date:** 2026-06-28
**Status:** Draft for review
**Area:** Field-day verdict (`lib/fieldDayVerdict.ts`, `lib/computeVerdicts.ts`, `lib/resolutions.ts`, `field-verdict` / `field-publish` / `field-remember` / `field-approvals` CLIs)

## Problem

The field-day verdict treats datasets as a single boolean: `datasetPosted: true/false`
(`lib/fieldDayVerdict.ts:20`). That flattens three operationally distinct realities into
"not posted":

1. A dataset **was** posted to `#datasets`.
2. No dataset was posted, **but** someone stated a reason — which the team considers a
   perfectly valid outcome.
3. No dataset, **no** reason — a genuine gap.

Today case 2 and case 3 both fall to `NEEDS_REVIEW` and sit there until one of the two
approvers explicitly forgives them. In reality a stated reason should make the day valid by
itself, while admins retain a veto to knock down a weak ("bs") reason. We want to **formalize
the list of dataset acceptance/rejection statuses** so the verdict says *why* a day is
accepted, not just whether it is.

## Goals

- A named, first-class dataset status enum, surfaced in all three interfaces (CLI table,
  Slack post, web view).
- A stated no-dataset reason **auto-validates** the dataset axis — no approver action needed.
- Admins (the existing `lib/approvers.ts` approvers) can **decline** a reason in-thread (the
  "bs filter"), flipping the day to rejected.
- Keep the recording-completeness (video ≥ 50%) gate independent of the dataset axis, so a
  day can be "dataset OK, video short" or vice versa.
- Leave the model extensible for a future **developer-acceptance** axis without rework.

## Non-goals (deferred)

- **Developer acceptance** (a developer separately confirming the dataset is usable for
  training). The axis model below reserves its slot, but no developer signal is implemented now.
- Changing the 50% video gate, the grace window, or who the approvers are.
- A backfill UI. Existing committed periods recompute from live + stored signals as usual.

## The taxonomy

```ts
// lib/fieldDayVerdict.ts
export type DatasetStatus = "POSTED" | "WAIVED" | "MISSING" | "DECLINED";
```

| Status | Meaning | Source signal | Satisfies dataset condition? |
|---|---|---|---|
| `POSTED` | A `#datasets` notice exists for the flight date | live Slack-mirror scan (today's `datasetPosted` detection) | ✅ yes |
| `WAIVED` | No dataset, but a reason was stated in-thread by anyone | a `dataset`-axis `accepted_exception` resolution recorded by `field-remember` | ✅ yes |
| `MISSING` | No dataset and no reason | absence of the above | ❌ no |
| `DECLINED` | An admin tagged the bot in-thread and rejected the reason | a `dataset`-axis `rejected` resolution recorded by `field-approvals` | ❌ no — forces day `REJECTED` |

Icons (extending the existing maps in `lib/verdictPublish.ts` and `scripts/fieldVerdictReport.ts`):
`POSTED ✅`, `WAIVED 📝`, `MISSING ✗`, `DECLINED ⛔`.

### Derivation precedence (in `computeVerdicts`)

For each flight date, resolve `DatasetStatus` in this order:

1. `dataset`-axis `rejected` resolution present → **DECLINED**
2. else `#datasets` notice present → **POSTED**
3. else `dataset`-axis `accepted_exception` resolution present → **WAIVED**
4. else → **MISSING**

(Admin decline wins over a notice only via the day-level rejection path; at the dataset axis,
DECLINED is reached only when there is no genuine posting to decline. A posted dataset that an
admin still rejects is a *day*-axis rejection, handled below — not a dataset DECLINED.)

## How the dataset status feeds the day verdict

`VerdictStatus` is unchanged (`ACCEPTED | PENDING | NEEDS_REVIEW | ACCEPTED_EXCEPTION |
REJECTED`). What changes is that the dataset condition reads `DatasetStatus` instead of a
boolean, and `DayVerdict.datasetPosted: boolean` is replaced by `datasetStatus: DatasetStatus`.

```
datasetOk = datasetStatus === "POSTED" || datasetStatus === "WAIVED"

if (datasetStatus === "DECLINED" || video-axis decline)   → REJECTED
else if (videoOk && datasetOk)                              → ACCEPTED
else if (video forgiven via video-axis exception && datasetOk) → ACCEPTED_EXCEPTION
else if (withinGrace)                                       → PENDING
else                                                        → NEEDS_REVIEW
```

Net effect of the change:

- A reasoned no-dataset day (`WAIVED`) with adequate video now reaches **ACCEPTED**
  automatically, instead of waiting in `NEEDS_REVIEW` for an approver.
- `ACCEPTED_EXCEPTION` shrinks to its true meaning: a **video**-gap forgiven by an approver
  (the dataset-reason case is now `WAIVED` → `ACCEPTED`).
- `DECLINED` is the dataset-specific path to `REJECTED`.

## Data model: axis-scoped resolutions

This is the one real schema change. Today a resolution is keyed by `date` alone
(`lib/schema.ts` — `resolutions.date` is the primary key) with
`decision: "accepted_exception" | "rejected"`. A single per-day decision cannot express
"dataset waived **and** video still short."

Add an `axis` discriminator:

```ts
// lib/resolutions.ts
export type ResolutionAxis = "dataset" | "video" | "day";
export interface Resolution {
  date: string;
  axis: ResolutionAxis;        // NEW — what the decision is about
  decision: "accepted_exception" | "rejected";
  note: string;
  source: string;
  recordedAt: string;
  by?: string;
}
```

- Neon `resolutions` table: primary key `date` → composite `(date, axis)`.
- Migration: existing rows backfill `axis = "day"` (preserves current whole-day semantics).
- `"day"` keeps working as a catch-all override that applies regardless of axis, so nothing
  that exists today regresses.
- The future developer axis is just `axis: "developer"` — no further schema change.

### Who writes which axis

- **`field-remember`** (team replies to the bot's no-dataset question): a reply classified as
  a valid reason → records `{ axis: "dataset", decision: "accepted_exception" }` → `WAIVED`.
  *Reason stated by anyone is enough.*
- **`field-approvals`** (admin replies in the verdict thread): admin approve → existing
  day/video behavior; admin **disapprove of a dataset reason** → records
  `{ axis: "dataset", decision: "rejected" }` → `DECLINED`. Most-recent admin reply wins
  (unchanged rule). This is the bs-filter.

Both paths already classify free Slack text via Claude and persist via `--write`; we are
extending their output with the `axis` field, not adding a new ingestion mechanism.

## Surfaces (two-interface rule)

1. **CLI** — `npm run field-verdict` table (`scripts/fieldVerdictReport.ts`) gains a
   `Dataset` column rendering the `DatasetStatus` + icon. The JSON artifact carries
   `datasetStatus`.
2. **Slack** — `formatDayMessage` (`lib/verdictPublish.ts`) replaces the
   `day.datasetPosted ? "dataset ✓" : "no dataset"` marker with:
   - `POSTED` → `dataset ✓`
   - `WAIVED` → `dataset 📝 waived: <reason>` (reason truncated to one line, ~120 chars)
   - `MISSING` → `no dataset`
   - `DECLINED` → `dataset ⛔ (declined by <admin>)`
3. **Web** — the field-verdict view renders a dataset-status badge per day, fed by the same
   committed JSON.

## Testing

- `lib/fieldDayVerdict.ts` (pure): table-driven cases for every `DatasetStatus × videoOk ×
  withinGrace` combination, asserting the resulting `VerdictStatus`. Key new cases:
  `WAIVED + videoOk → ACCEPTED`; `DECLINED → REJECTED`; `MISSING + after grace →
  NEEDS_REVIEW`; `WAIVED + video short + after grace → NEEDS_REVIEW` (dataset OK, video axis
  still fails).
- `lib/resolutions.ts` (pure): axis-scoped overlay — a `dataset` waiver and a `video`
  exception on the same date both apply independently; a `day` resolution still overrides.
- `lib/verdictPublish.ts` (pure): marker rendering for each `DatasetStatus`.
- Migration test / backfill assertion: legacy rows resolve to `axis = "day"`.

## Resolved decisions

1. **Marker wording** — a waiver must not read as a clean pass. Use the `📝` marker, not `✓`:
   `dataset 📝 waived: <reason>`. `POSTED` keeps `dataset ✓`.
2. **DECLINED reach** — `DECLINED` is strictly the bs-filter on *waived reasons*. A
   genuinely posted but low-quality dataset is a separate day-axis rejection, out of scope here.
3. **Reason capture for WAIVED** — store the verbatim reason text in `Resolution.note`;
   surface it in the marker, truncated to a single line (~120 chars) for the Slack post.
