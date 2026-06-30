# Field crew on verdicts + approver thread-corrections

**Date:** 2026-06-30
**Status:** Design (approved to write)
**Related:** `2026-06-19-field-day-acceptance-and-publishing-design.md` (verdict + S4/S7 publishing), `2026-06-28-ukrainian-bot-messages-design.md` (Ukrainian posts), `.claude/skills/field-bonus/` (the bonus model)

## Problem

The published per-flight-day verdict (e.g. `✅ 2026-06-13 — прийнято …`) tells the team whether a day's recording passed the gate, but **not who was in the field that day**. Bonuses are per-person (700/trip + 200 early + 300 weekend, with a drone-loss multiplier), so to "give bonuses correctly" the crew per day must be visible — and, when the auto-parsed crew is wrong (a missing person, a misread initial, or someone who shouldn't count that day), **an approver must be able to correct it in the verdict thread**, with the correction flowing back into the bonus math.

The roster already exists internally: `FieldReport.roster: string[]` is parsed from the #field-qa "Звіт" reports (`lib/fieldReports.ts`, initials resolved via `lib/fieldRoster.ts` + DB aliases) and carried per-day as `DayBonus.roster` by `field-bonus`. But `DayVerdict` — the object that gets published — has no roster field, and there is no path to correct the crew.

## Sequencing dependency (added 2026-06-30)

The verdict layer is **mid-migration**: `DayVerdict` already moved from `datasetPosted: boolean` to a `DatasetStatus` enum (`POSTED|WAIVED|MISSING|DECLINED`, see the dataset-acceptance taxonomy), but its consumers (`computeVerdicts`, `verdictPublish`, `fieldVerdictReport`, `askGaps`, the web page, several tests) were not all updated — `npx tsc --noEmit` reports ~30 errors and `lib/resolutions.ts` is uncommitted. `npm test` stays green only because Vitest does not typecheck.

This roster feature is **additive and orthogonal** to the dataset axis, but it edits the same files. **Execution is gated:** do not start coding until the `datasetPosted → datasetStatus` migration has landed, the tree typechecks clean (`npx tsc --noEmit` → 0 errors), and `lib/resolutions.ts` is committed. Implement in an isolated git worktree. All code below targets the **post-migration** shapes; where it touches `formatDayMessage` / the table / the web row, it **wraps** the existing body rather than rewriting the dataset wording, so it composes with whatever the migration settles on.

## Decisions (from brainstorming)

1. **Correction scope:** roster **+ per-day bonus eligibility** — a thread reply can add/remove/replace the crew *and* mark a person counted/not-counted for that day's bonus (overriding the per-day gate per person). The verdict numbers (airborne/video/dataset) are **not** corrected here — that stays the existing `accepted_exception`/`rejected` override path.
2. **Authority:** **approvers only** (`lib/approvers.ts` — Oleksandr K, Bohdan Forostianyi). Reuses `approverFor`. Bonus-affecting edits are gated exactly like verdict overrides.
3. **What the message shows:** **roster names only** on the published line. Bonus amounts stay in the separate `field-bonus --notify` thread post / DMs.
4. **CLI shape:** a **new `npm run field-roster`** command mirroring `field-approvals` (own classifier, own store, own tests). DRY-RUN by default; `--write` applies.
5. **Ack behavior:** on an accepted correction, **edit the verdict line** (swap the crew suffix) **and post a Ukrainian threaded ack**. Full audit trail, consistent with the override flow.

### Resolved flags

- **Unknown initials:** the Slack line stays names-only. If an initial does not resolve (e.g. `Ж`), that token is **omitted from the Slack crew line** but **surfaced in the `field-verdict` CLI table and web view** (internal) as `unknownInitials`, so the gap is visible somewhere and is the obvious correction target. (Trade-off accepted: the CEO sees a possibly-short crew on Slack, but the internal surfaces flag the unresolved token.)
- **Live webhook path:** the correction effect lives in a shared `lib/applyRosterCorrection.ts` so the `/api/slack/events` webhook *can* call it, but **only the `field-roster` CLI is wired in this spec**. Real-time webhook roster-corrections are a noted follow-on (one call site, same module).

## Architecture

Five touch-points; each unit has one purpose and is testable in isolation.

```
#field-qa "Звіт"  ──parseMonth──▶ roster by flightDate ─┐
                                                         ├─▶ computeVerdicts ─▶ DayVerdict{roster,unknownInitials}
roster_corrections (DB) ──applyRosterCorrection──────────┘        │
                                                                  ├─▶ formatDayMessage  → "…\n👥 У полі: A, B, C."
                                                                  └─▶ field-verdict report JSON/CSV + web

published verdict thread ─▶ field-roster CLI ─▶ approver replies ─▶ rosterCorrectionClassify (Claude)
                                                                  ─▶ replay → effective correction
                                                                  ─▶ applyRosterCorrection: upsert + edit suffix + ack

roster_corrections (DB) ──▶ computeBonuses ──▶ fieldBonus.computeBonuses (corrected roster + per-person counted)
```

### 1. `DayVerdict` carries the crew — `lib/fieldDayVerdict.ts`

Add two **display/attribution** fields. They are NOT inputs to `verdictForDay` (the pure gate) — they're attached by the orchestrator:

```ts
export interface DayVerdict {
  date: string;
  status: VerdictStatus;
  airborneMinutes: number;
  videoMinutes: number;
  ratio: number | null;
  datasetStatus: DatasetStatus;  // post-migration enum (unchanged by this feature)
  withinGrace: boolean;
  reasons: string[];
  roster: string[];            // NEW — resolved crew names for the day (corrected if a correction exists)
  unknownInitials: string[];   // NEW — tokens that did not resolve to a name (internal surfaces only)
}
```

`verdictForDay` returns `roster: []`, `unknownInitials: []` (the gate doesn't know the crew); the orchestrator overwrites them. Existing tests that build a `DayVerdict` get the two empty defaults.

### 2. Orchestrator attaches + corrects the crew — `lib/computeVerdicts.ts`

After the existing inputs, add (mirroring `computeBonuses`):

```ts
import { parseMonth } from "./fieldReports";
import { readAliases, mergeAliases } from "./rosterAliases";
import { SEED_ALIASES } from "./fieldRoster";
import { readRosterCorrections } from "./rosterCorrections";
import { applyRosterCorrection } from "./rosterCorrection";

const aliases = mergeAliases(SEED_ALIASES, await readAliases());
const fieldQaMessages = (await readChannelMessages("field-qa", period)).filter((m) => !m.deleted);
const reports = parseMonth(fieldQaMessages, aliases);
const parsedByDate = new Map(reports.map((r) => [r.flightDate, r]));
const corrections = await readRosterCorrections();
```

When building each `DayVerdict`, attach the **effective** crew:

```ts
const parsed = parsedByDate.get(date);
const correction = corrections.find((c) => c.date === date);
const eff = applyRosterCorrection(parsed?.roster ?? [], /*counted*/ true, correction);
return {
  ...applyResolution(base, resolutions),
  roster: eff.roster,
  unknownInitials: parsed?.unknownInitials ?? [],
};
```

(The `counted` arg is irrelevant for the verdict — it's used by the bonus calc; here we just need `eff.roster`.)

> Note: a flight day appears in the verdict because it has airborne minutes in the field-qa report. A day with airborne minutes but no parseable "Звіт" gets `roster: []` — surfaced as an empty crew (another correction target).

### 3. Crew suffix on the message — `lib/verdictPublish.ts`

The crew is a **structured trailing line** so it can be rewritten independently of an override amendment.

```ts
export const ROSTER_MARKER = "👥 У полі: ";

/** Append (or omit) the crew suffix. Pure. */
export function withRosterSuffix(body: string, roster: string[]): string {
  if (roster.length === 0) return body;
  return `${body}\n${ROSTER_MARKER}${roster.join(", ")}.`;
}

/** Split a published message into { body, roster } at the crew marker. Pure. */
export function splitRosterSuffix(text: string): { body: string; rosterLine: string | null } {
  const idx = text.lastIndexOf(`\n${ROSTER_MARKER}`);
  if (idx === -1) return { body: text, rosterLine: null };
  return { body: text.slice(0, idx), rosterLine: text.slice(idx + 1) };
}
```

`formatDayMessage(day)` returns `withRosterSuffix(<existing body>, day.roster)` for all three publishable statuses.

**Interaction with the override editor (the one tricky part):**
- `formatOverride` operates on the **body only** — it must strike/amend the verdict body, NOT the crew suffix. The publisher splits the current text with `splitRosterSuffix`, runs `formatOverride` on `body`, then re-appends the original `rosterLine`. So a struck-through override never strikes the crew line.
- The roster editor (`applyRosterCorrection`) does the inverse: it keeps `body` untouched and replaces only the crew suffix via `withRosterSuffix`.

Result: the two editors own disjoint regions of the published message and never clobber each other regardless of order.

### 4. Correction store + pure apply — `lib/schema.ts`, `lib/rosterCorrections.ts`, `lib/rosterCorrection.ts`

New table (mirrors `resolutions` — keyed by flight `date`, one effective correction per day):

```ts
export const rosterCorrections = pgTable("roster_corrections", {
  date: text("date").primaryKey(),
  roster: jsonb("roster"),            // string[] | null — authoritative crew (replaces parsed)
  eligibility: jsonb("eligibility"),  // Record<name,"counted"|"not_counted"> | null
  note: text("note").notNull(),
  by: text("by").notNull(),           // approver name
  source: text("source").notNull(),   // permalink to the deciding reply
  recordedAt: text("recorded_at").notNull(),
});
```

`lib/rosterCorrections.ts` (NOT server-only — CLIs import it, like `resolutions.ts`): `readRosterCorrections()`, `upsertRosterCorrection(c)` (insert-or-replace on `date`).

`lib/rosterCorrection.ts` (pure, unit-tested):

```ts
export interface RosterCorrection {
  date: string;
  roster?: string[];
  eligibility?: Record<string, "counted" | "not_counted">;
  note: string; by: string; source: string; recordedAt: string;
}

/** Effective crew + per-person counted flag for a day, given the parsed baseline. */
export function applyRosterCorrection(
  parsedRoster: string[],
  dayCounted: boolean,
  correction?: RosterCorrection,
): { roster: string[]; perPerson: { name: string; counted: boolean }[] } {
  const roster = correction?.roster ?? parsedRoster;
  const perPerson = roster.map((name) => ({
    name,
    counted: correction?.eligibility?.[name] === "not_counted" ? false
           : correction?.eligibility?.[name] === "counted" ? true
           : dayCounted,
  }));
  return { roster, perPerson };
}
```

### 5. Classifier — `lib/rosterCorrectionClassify.ts` + `lib/rosterCorrectionClassifyPrompt.ts`

Follows `approvalClassify` / `answerClassify`: Claude with a forced StructuredOutput tool, given the verdict text + one reply. Returns:

```ts
export type RosterCorrectionKind = "set_roster" | "eligibility" | "unclear";
export interface RosterCorrectionClassification {
  kind: RosterCorrectionKind;
  roster?: string[];                 // for set_roster — the authoritative crew named in the reply
  include?: string[];                // names to mark counted
  exclude?: string[];                // names to mark not_counted
  reason: string;                    // short human explanation (English; internal)
}
```

The prompt explains the two intents in Ukrainian-aware terms:
- *set_roster* — the reply states who was actually in the field ("були А, Б, В" / "додай Тараса" / "Влад не був").
- *eligibility* — the reply leaves the crew but changes who counts for the bonus ("Данило не рахується цього дня", "Тарасу зарахуй").
- *unclear* — anything else → no-op.

Names are normalised through the same alias resolution (`resolveInitial`) so "додай Т" and "Тарас" land on the same canonical name. Add/remove deltas (`додай`/`прибери`) are applied against the day's current effective roster during replay (see §6), so the classifier may return either a full `roster` or `include`/`exclude` deltas.

### 6. The `field-roster` CLI — `scripts/field-roster.ts` + `scripts/fieldRosterReport.ts`

Pure helper `scripts/fieldRosterReport.ts`: `parseArgs`, `resolvePeriod`, and `decideRosterCorrection(parsedRoster, classifiedReplies)` — replays approver replies in `ts` order onto the parsed baseline to produce the **effective** `RosterCorrection` (full `roster` after applying any set/add/remove, plus the accumulated `eligibility` map). Most-recent `set_roster` wins for the crew list; eligibility entries accumulate with later replies overriding earlier ones for the same person. `unclear` replies are skipped. Returns `null` when no decisive reply exists.

`scripts/field-roster.ts` (mirrors `field-approvals.ts`):

```
npm run field-roster -- --start 2026-06-01 --end 2026-06-19           # dry-run
npm run field-roster -- --start … --end … --write                    # apply corrections
```

Flow: load env → resolve period (default current Kyiv month) → `readPublished(period)` → for each entry, read thread replies from the mirror over `readWindow` (period.start … max(period.end, today), same as approvals) → keep approver replies (`approverFor`) → classify each → `decideRosterCorrection` → with `--write`, call `applyRosterCorrection` effect. DRY-RUN prints each reply's classification and the would-be effective crew; non-approver replies are logged and ignored. Runs under `--conditions=react-server` (server-only Vimeo not needed here, but classify is server-side). `package.json` script + a `.claude/skills/field-roster/` skill + a CLAUDE.md Commands bullet.

### 7. The correction effect — `lib/applyRosterCorrection.ts` (server-only)

One source of truth for the effect (callable by the CLI now, the events webhook later), mirroring `lib/applyApproval.ts`:

```ts
export async function applyRosterDecision(args: {
  entry: PublishedEntry;
  period: Period;
  correction: RosterCorrection;     // effective, from decideRosterCorrection
  trigger?: SendTrigger;
}): Promise<{ applied: boolean; alreadyAcked: boolean }>;
```

1. `upsertRosterCorrection(correction)`.
2. Edit the published verdict: `splitRosterSuffix(entry.text)` → `withRosterSuffix(body, correction.roster)` → `updateMessage(channel.id, entry.ts, newText, { key: rosterEditKey(date, contentRev(newText)), feature: "roster", … })`. Skips when the suffix is already identical (content-rev dedup).
3. Post a Ukrainian threaded ack: `👥 Зафіксовано склад: A, B, C — <by>.` (plus `(не рахується: X)` when eligibility excludes someone), key `rosterAckKey(date, contentRev(reply))`, `feature: "roster"`.
4. Persist the new published `text` (so re-runs and later overrides see the corrected suffix).

New keys in `lib/outboundKeys.ts`: `rosterEditKey`, `rosterAckKey`. New `feature: "roster"` value (extend the `outbound_messages.feature` comment/union, the Outbound tab filter, and any feature enum).

### 8. Bonus math consumes corrections — `lib/computeBonuses.ts` + `lib/fieldBonus.ts`

`computeBonuses` (lib): `const corrections = await readRosterCorrections();` then pass into the pure calc. `fieldBonus.computeBonuses` input gains `corrections: RosterCorrection[]`. In the per-day loop, replace the current `roster` + `if (!d.counted) continue;` per-name tally with the effective values:

```ts
const eff = applyRosterCorrection(r.roster, dayCounted, corrections.find((c) => c.date === r.flightDate));
days.push({ ...day, roster: eff.roster });
for (const { name, counted } of eff.perPerson) {
  if (!counted) continue;
  // existing trips/early/weekend tally
}
```

So a corrected crew and a per-person `not_counted` flow straight into `PersonBonus`. `DayBonus.roster` shows the corrected crew.

### 9. Both interfaces (CLAUDE.md requirement)

- **CLI:** `field-verdict --format table` gains a `crew` column (names; `unknownInitials` shown as `?<tok>`). New `field-roster` command. `field-bonus` output already reflects corrections via §8.
- **Web:** the verdict view renders `day.roster` (the `field-verdict` report JSON now carries it — `GET /api/field-verdict` unchanged, it just serves the richer JSON). Corrections surface automatically (crew reflects the store); the edit + ack already appear in the **Outbound** tab (new `feature: "roster"`).

## Error handling

- No committed field-qa report → roster map empty → crews render empty (already logged by `computeVerdicts`); corrections still apply.
- Reply from a non-approver → logged, ignored (no store write, no Slack edit).
- `unclear` classification → no-op.
- Channel not tracked → correction is still written to the store (bonus reflects it) but the Slack edit/ack is skipped, exactly as `applyApproverDecision` degrades.
- Idempotency → `rosterEditKey`/`rosterAckKey` content-revs + reserve-then-send dedup at `lib/slack.ts`; re-running `field-roster` with the same replies is a no-op.
- A day with both a status override and a roster correction → disjoint message regions (§3) keep both amendments intact regardless of which ran last.

## Testing (TDD; pure modules first)

- `lib/rosterCorrection.test.ts` — `applyRosterCorrection`: replace vs. baseline, per-person `counted`/`not_counted` overriding `dayCounted`, empty correction passthrough.
- `scripts/fieldRosterReport.test.ts` — `decideRosterCorrection` replay: most-recent `set_roster` wins, accumulating eligibility, add/remove deltas, `unclear`/empty → null, ts ordering.
- `lib/verdictPublish.test.ts` (extend) — `withRosterSuffix`/`splitRosterSuffix` round-trip; `formatDayMessage` appends the crew line for each status and omits it for an empty roster; **an override strike leaves the crew line intact** (the disjoint-region invariant).
- `lib/fieldBonus.test.ts` (extend) — corrected roster + `not_counted` change `PersonBonus` tallies.
- Classifier prompt: a small fixture test asserting the structured shape (kind/roster/include/exclude) for representative Ukrainian replies, consistent with existing classify tests.

## Out of scope

- Real-time roster corrections via the `/api/slack/events` webhook (effect module is ready; wiring deferred).
- Correcting the verdict numbers (airborne/video/dataset) — that remains the `accepted_exception`/`rejected` path.
- Showing bonus amounts on the verdict line (stays in `field-bonus --notify`).
- Surfacing unknown initials on the Slack line (internal surfaces only).

## Files

**New:** `lib/rosterCorrection.ts`, `lib/rosterCorrections.ts`, `lib/rosterCorrectionClassify.ts`, `lib/rosterCorrectionClassifyPrompt.ts`, `lib/applyRosterCorrection.ts`, `scripts/field-roster.ts`, `scripts/fieldRosterReport.ts`, `.claude/skills/field-roster/SKILL.md`, plus tests.

**Changed:** `lib/fieldDayVerdict.ts` (+2 fields), `lib/computeVerdicts.ts` (parse roster + attach + correct), `lib/verdictPublish.ts` (crew suffix helpers + `formatDayMessage` + override split/re-append), `lib/computeBonuses.ts` + `lib/fieldBonus.ts` (consume corrections), `lib/schema.ts` (+table), `lib/outboundKeys.ts` (+2 keys), `scripts/fieldVerdictReport.ts` (table crew column; JSON already structural), the verdict web view (+crew), the Outbound tab feature filter (+`roster`), `package.json` (+script), `CLAUDE.md` (+Commands bullet).
