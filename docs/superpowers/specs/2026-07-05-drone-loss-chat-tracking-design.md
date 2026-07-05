# Drone-loss tracking in Slack chat — design

**Date:** 2026-07-05
**Status:** approved (brainstorm with operator)

## Problem

Drone-loss state (`втрата борта` / `знайшли`) drives real money — the per-crew
−50 %/−100 % multiplier and the team-wide >3-loss month wipe — yet it is
invisible and untrackable in Slack today:

- Losses are **ephemeral**: re-derived by Claude (`lib/lossExtract.ts`) from
  each Звіт's crash text on every manual `field-bonus` run. No store, no
  history, and the counter is only as fresh as the last manual run.
- Published verdict messages carry no loss line.
- The approver-instruction machinery has no loss axis — the only way to record
  a recovery is the undocumented convention of **editing the Звіт message**
  (thread replies are never parsed for loss).
- The nightly never recomputes the counter, so nobody is alerted when the team
  approaches the >3 cliff (state on 2026-07-05: 2 unrecovered losses — 04.07
  and 05.07; a 4th zeroes July for everyone).
- The Slack agent has only Jira tools — «скільки втрат бортів?» in a DM fails.

## Decisions (operator-confirmed)

1. All four capabilities ship: day-message loss line, approver loss
   instruction, nightly counter + alerts, agent read tool.
2. The month counter lives in **alerts + bot answers only** — never on
   published day messages (no mass re-edits when it moves).
3. **Tiered alerts**: every counter change → operator DM; the 3rd unrecovered
   loss → additionally a Ukrainian warning post in #field-qa.
4. Thread-reply recovery is **approver-only** (same gate as every other
   data-overwrite axis). The Звіт-edit path keeps working for initial
   declarations.
5. Architecture: **durable loss ledger** (approach A) — a Neon table all
   consumers read, extraction writes, instructions override.

## 1. Data model — `loss_records`

New Neon table, primary key `(date, report_ts)`:

| column | type | meaning |
| --- | --- | --- |
| `date` | `text` | flight date `YYYY-MM-DD` (the Звіт's own date) |
| `report_ts` | `text` | Звіт message ts — the report's identity |
| `lost` | `boolean` | a drone was lost/crashed/destroyed |
| `found` | `boolean` | the lost drone was recovered (⇒ not a loss per the rules) |
| `note` | `text` | classifier note / instruction reason |
| `source` | `text` | `extracted` \| `instruction` |
| `crash_text_hash` | `text` | hash of the Звіт crash text at classification time (`extracted` rows) |
| `updated_at` | `timestamptz` | |
| `updated_by` | `text` | approver name on `instruction` rows |

**Precedence rule** (pure, tested, own function in `lib/lossStore.ts`): an
`extracted` upsert never overwrites an `instruction` row for the same key; a
new `instruction` always wins. Mirrors `sheetImportShouldSkip`.

**Team counter** for a period = `count(distinct date)` over rows with
`lost = true and found = false` — the same dedup-by-date semantics
`computeBonuses` already uses (two same-date reports with losses = one loss).

`lib/lossStore.ts` is CLI-safe (no `server-only`, like `lib/reports.ts`) and
owns read/upsert/counter.

Alert-state table `loss_alerts`: `(period_key, last_alerted_count,
fieldqa_warned_at_3 boolean)` — mirrors `bonus_notified`'s role of "what did we
already tell people".

## 2. Nightly stage — extraction, counter, tiered alerts

A new stage in `lib/runNightly.ts` between extract and verdict, best-effort
like the crew stage (a failure never blocks verdict/publish; it logs and DMs
the operator via the existing `notifyOperator`):

1. For each parsed Звіт in the catch-up window with non-empty `crashText`:
   compare `sha256(crashText)` to the stored `crash_text_hash`; classify via
   the existing `extractLoss` **only** when the hash changed or no row exists;
   upsert an `extracted` row (respecting precedence). A normal night makes
   **zero** Claude calls.
2. Recompute the period counter; diff against `loss_alerts`:
   - changed (up or down) → operator DM, e.g. «Втрати бортів у липні: 3
     (було 2). Наступна втрата обнуляє місяць для всієї команди.»
   - reached ≥3 and `fieldqa_warned_at_3` unset → Ukrainian warning post in
     #field-qa (team-facing ⇒ Ukrainian, per house rule), then set the flag.
   - Both sends go through the `lib/slack.ts` reserve-then-send chokepoint
     (recorded + deduped in `outbound_messages`).

The CLI mirror `npm run field-nightly` runs the same stage (dry-run prints the
would-be alerts).

## 3. Chat rendering — the loss line on verdict messages

- `DayVerdict` gains `loss?: { lost: boolean; found: boolean }`, populated
  from the ledger in the `computeVerdicts` orchestration. **Per-report**, not
  day-shared: a loss belongs to the Звіт that declared it.
- `formatDayMessage` renders one new line in the facts-tail region:
  - lost, not found → `⚠️ Втрата борта (не знайдено)`
  - lost, found → `✅ Борт втрачено і знайдено`
  - no loss → **no line** (byte-identical output for every existing message —
    no backfill needed; only the 04.07/05.07 messages re-edit on the next
    nightly).
- Loss-state flips propagate through the existing `lib/refreshPublished.ts`
  re-edit machinery (date-salted edit keys, approver-overridden entries
  skipped) — no new edit path.
- No counter on day messages (decision 2).

## 4. Instruction axis — `loss`

`InstructionAxis` gains `"loss"`; the classify tool gains
`lossState: "found" | "lost"` (e.g. «борт знайшли» → `found`; «борт таки
втрачено» → `lost`). Everything rides the existing machinery unchanged:

- **Webhook (confirm-first):** approver replies in the verdict thread →
  `📝 Зрозумів: борт за 04.07 знайдено — підтвердіть («так»)` → on «так»/👍
  `applyInstruction` writes the `instruction`-source ledger row for that
  verdict's `(date, reportTs)` and posts the Ukrainian ack. Requester/approver
  gating, `source_reply_ts` idempotency, cancel/unclear handling — all
  inherited.
- **Sweep + manual:** `npm run field-instructions -- --date D --loss
  found|lost [--by NAME] [--reason …]`, and the sweep classifies loss replies
  like any other axis. `--list` shows loss proposals/corrections; they appear
  in `GET /api/instructions` (Instructions tab) automatically.
- A multi-report day scopes the instruction to the report whose thread the
  reply is in — same rule as crew/accept-reject.

## 5. Agent read tool — `field_loss_status`

New read tool beside `jira_search` in `lib/agent/tools/`:

- input: `{ start?: string, end?: string }` (defaults to the current Kyiv
  month), output: ledger rows + counter + margin
  (`{ losses: [...], unrecovered: 2, cutoff: 3, monthWipedAt: 4 }`).
- Read tools execute live without confirmation (same class as `jira_search`),
  so «скільки втрат бортів у липні?» works in DM/@mention/thread and the CLI
  twin `npm run agent`.

## 6. Two interfaces (house rule)

- **CLI:** `npm run field-loss -- --start … --end … [--format table]` — prints
  ledger rows, the counter/margin, and per-crew penalty exposure (which crews
  carry a loss in their 12-trip window). Mirrors `GET /api/field-loss`.
  Writes go through `field-instructions --loss` only — no second write path.
- **Web:** a **Losses** view rendering `GET /api/field-loss` (DB-backed live
  state like the Instructions tab — no committed period artifact; the ledger
  is operational state, not a period report).
- **`field-bonus` converges on the ledger:** its orchestration
  (`lib/computeBonuses.ts`) stops calling `extractLoss` per run and reads
  `loss_records` (classifying any un-hashed Звіт it encounters, so a cold CLI
  run without a prior nightly still works). The pure `computeBonuses`
  signature (`losses: LossRecord[]`) is unchanged. CLI, nightly, agent, and
  web can then never disagree about the counter.

## 7. Error handling

- Classifier failure → keep the previous row, log, operator DM. Never
  fabricate `found = true`; when in doubt a loss stays a loss.
- Ledger unavailable → no new failure mode for `field-bonus` (it already
  hard-requires `POSTGRES_URL` for roster aliases and exits non-zero without
  it); the nightly loss stage reports failure but publish continues.
- Alert send failure → `loss_alerts` is **not** advanced (alert retries next
  night); the reserve-then-send chokepoint prevents double-posts.

## 8. Testing

Pure units (vitest, existing `server-only` alias + `vi.hoisted` conventions):

- precedence rule: extracted-vs-instruction upsert matrix
- counter math: same-date dedup, found-flip, cross-month clamp
- `formatDayMessage`: all three loss states; byte-identical output when
  `loss` is absent
- instruction classification prompt: «знайшли борт» → found; «борт не
  знайдемо» → lost(no-op if already lost); a question → `unclear`
- alert transitions: 2→3 (DM + #field-qa warn once), 3→2 (recovery DM,
  no duplicate warn on a later re-3), redelivery idempotency
- agent tool: shape + default period

## Out of scope

- **Cross-date catch-up Звіти:** `extractLoss` yields one verdict per Звіт,
  keyed to the Звіт's own date. A single message listing another day's loss
  attributes it to the wrong date. Kept as-is (matches current behaviour; the
  07-04/07-05 pair classified correctly because they were separate Звіти).
  The loss instruction axis is the correction path if it ever misfires.
- Per-crew penalty *prediction* in alerts (which crew is one loss from −50 %)
  — the CLI/web expose exposure; alerts stay simple.
- The assemblers' ready-drone fund (separate domain).
