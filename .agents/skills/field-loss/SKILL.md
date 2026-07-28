---
name: field-loss
description: Use when answering questions about lost drones (втрата борта) — how many losses this month, which were recovered, how close the team is to the >3-loss month wipe, or which crew carries penalty exposure.
---

# Field Drone Losses

The durable source of loss truth is the `loss_records` Neon ledger: the nightly
(and any `field-bonus` run) classifies each #field-qa Звіт's crash text via
Codex (hash-gated — unchanged text is never re-classified), and approver
instructions («борт знайшли» in a verdict thread, or
`npm run field-instructions -- --date D --loss found|lost --write`) write
override rows that permanently outrank extraction.

## How to answer

Run the read-only CLI (defaults to the current Kyiv month):

    npm run field-loss -- --start 2026-07-01 --end 2026-07-31 [--format table]

JSON fields: `losses[]` (`{date, found, note}` — the effective per-date view),
`unrecovered`, `cutoff` (3), `teamZeroed` (>3 unrecovered wipes the whole
team's month), `penalties[]` (crew exposure from the committed field-bonus
report — −50% at 2 losses within 12 crew trips, −100% at 3).

Needs `POSTGRES_URL`. The web mirror is the **Losses** tab (`GET
/api/field-loss?period=YYYY-MM`); in Slack, ask the agent «скільки втрат
бортів у липні?» (the `field_loss_status` tool).

## Correcting the ledger

Never edit rows by hand. A recovery is an approver reply «борт знайшли» in the
day's verdict thread (confirm-first), the manual CLI above, or asking the
agent in a DM (e.g. «зафіксуй, що борт за 06.07 знайшли») — the agent proposes
a `field_loss_set` write and applies it confirm-first, only for an authorized
approver (`lib/proposalGate.ts`); the Звіт-edit path still works for initial
declarations (the next sync re-classifies edited text).
