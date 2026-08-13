---
name: field-bonus
description: Use when answering questions about per-person field bonuses — "what did X earn in May?", "how many qualifying trips". Computes bonuses from #field-qa flight hours + Vimeo video data. Gate: the day's field-verdict status (unified 4-axis gate — deploy, video, drone-count, dataset).
---

# Field Bonus

Answer per-person bonus questions using this repo's CLI. Recomputes bonuses from #field-qa flight hours and live Vimeo video data.

## Domain (must-know)

- A **trip counts** iff the day's field-verdict status is ACCEPTED or ACCEPTED_EXCEPTION — the unified gate: deployment ≥ **3 hours**, video ≥ max(**2 minutes**, 50% of airborne), a **drone-count report** in #field-qa, and a **dataset notice**. «Прийнято» in Slack ⇔ the crew is paid. Unsettled days sit in `pendingDays` (not paid); REJECTED days in `voidedDays`. Exception: a per-person `eligibility: "counted"` roster correction from an approver overrides the day gate for that person — the deliberate person-level escape hatch, mirroring the day-level approver exception.
- Bonuses are: **700** per qualifying trip + **200** early (arrival ≤12:30 Kyiv) + **300** weekend (Sat/Sun) — apply early/weekend stacking per deployment.
- **>2-crew split (rules doc: «коли 3 людини — ділити на усіх»):** the pot is sized for a 2-person crew. With more than 2 bonus-counted people on a report, each person's day amount is scaled by `min(2, N) / N` (`days[].splitFactor`; `days[].paidRoster` lists who shares). An approver `not_counted` exclusion shrinks N, raising the remaining shares back toward full. Split is per **Звіт**, not per date. Person `gross`/`net` round once at period level, so expect ±1 ₴ vs naive per-day sums.
- **Per-person drone-count gate (from 2026-07-28):** a drone owner (`lib/droneOwners.ts` — Влад/Любомир/Андріан) on a counted Звіт is paid only if they **authored** their own drone-count message for that date. A teammate listing their counts does not satisfy it. **Not retroactive** — dates before `DRONE_GATE_EFFECTIVE_DATE` are exempt, because counts were posted collectively then; if you see a pre-cutoff exclusion, that is a bug, not a policy. Excluded people surface as `no_drone_count` flags and shrink `paidRoster` (which re-divides that Звіт's pot — see the split rule above).
- There is a **drone-loss multiplier** for deployments where the drone was lost; the classifier runs via Claude and scans the #field-qa thread + Vimeo video names for loss evidence.
- Videos are attributed to a flight day by the **date encoded in the video name** (via `videoFlightDate`), robust to upload lag. Day boundaries use **Europe/Kyiv**, not UTC. `created_time` is a fallback only.
- **Team cutoff**: if >3 drones are lost (all people in the period), the team is zeroed and all net bonuses become 0. This is the only cutoff — there is NO per-person trip filter.

## When to use

Any question like: "what did person X earn in May?", "how many trips qualified last month?", "which people hit the team cutoff?", "what's the raw bonus report?".

For the whole-period payout report (totals + who gets paid + voided days), use the **bonus-report** skill.

## How to use

Run the CLI (defaults to the current Kyiv month if you omit the dates):

```bash
npm run field-bonus -- --start 2026-05-01 --end 2026-05-31
```

It prints JSON:

- `period` — `{ start, end, timezone }`
- `people[]` — `{ name, trips, early, weekend, gross, penaltyPct, net }` (all people with ≥1 qualifying trip)
- `days[]` — per-day breakdown with roster, deployment minutes, video minutes, and reason code
- `total` — the summed net bonuses (0 if `teamZeroed`)
- `teamZeroed` — true only if >3 drones were lost (only cutoff — no per-person trip filter)
- `penalties[]` — drone-loss multipliers by flight group
- `flags[]` — unknown initials, counted-but-no-video warnings, etc.

Answer totals from `total`; per-person from `people[]`. Add `--format table` for a human-readable view. Add `--sheet <path>` to reconcile against a normalized CSV export (`person,trips,early,weekend`) and print divergences.

To persist a period as a committed artifact, add `--write`: it writes the lossless stats to `reports/field-bonus/<period>.json` (the web's render source — same shape as above) and a flat `reports/field-bonus/<period>.csv` (`person,trips,early,weekend,gross,penaltyPct,net`), printing both paths to stderr. The web renders the committed JSON via `GET /api/field-bonus?period=<key>` (and lists committed periods via `?periods=1`); the live `?start=&end=` path still recomputes fresh from #field-qa + Vimeo.

Dates are inclusive and must be `YYYY-MM-DD`.

## Prerequisites

- Run `npm run slack-sync` first — the CLI reads the **#field-qa** Slack mirror for flight-hour reports (`data/slack/field-qa/<YYYY-MM>.json`).
- Set `VIMEO_TOKEN` in `.env` — the CLI fetches live videos from Vimeo to count recorded minutes per person per day.
- Set `ANTHROPIC_API_KEY` in `.env` — Claude classifies drone-loss records from #field-qa threads and video names.
- Set `POSTGRES_URL` in `.env` — the CLI reads the roster aliases DB table (`roster_aliases`) to normalize person names.

Missing any of these makes the CLI exit non-zero with a clear message — tell the user to set them in `.env`.

## Rolling notification (`--notify`)

As each flight day's acceptance settles (verdict ≠ PENDING), post that day's
per-person breakdown in the day's verdict thread and DM each participant their
**provisional** share (the monthly drone-loss multiplier settles separately).

- Dry-run: `npm run field-bonus -- --start … --end … --notify` (prints, sends nothing).
- Send: add `--publish --channel <name>` (needs `chat:write`, `im:write`; use a private test channel first).
- Idempotent via the `bonus_notified` table; only settled, already-`field-publish`ed days are notified; names without a Slack id are skipped and flagged (add them to `SLACK_ID_OVERRIDES` in `lib/fieldSlackIds.ts`).
- Prereqs: run `npm run field-verdict -- --write` and `npm run field-publish -- … --publish` first.

## Out of scope

The assemblers' "Бонус за готові дрони" (ready-drone) fund is **not** computed here — it is a separate in-house fund for ready/delivered drone units, not deployment bonuses. This CLI covers only deployment-based field bonuses.

The in-thread unknown-initial flow (`--ask`/`--publish`) is **planned but not yet implemented** — the skeleton exists, but the bot does not proactively ask about missing trip data or unclassified drones during normal runs.
