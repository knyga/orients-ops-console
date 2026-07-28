# @mentions for people in bot Slack posts — design

**Date:** 2026-07-28
**Status:** approved, pre-implementation

## Problem

Bot posts to Slack name people as plain Cyrillic text — e.g.

```
⚠️ 2026-07-18 (субота) — потрібна перевірка: … (…).
👥 У полі: Андріан.
🛸 Дрони: Андріан 2, Любомир 2 (усього 4)
```

Plain names do **not** notify anyone. We want people mentioned with `<@SLACK_ID>` so
Slack pings them. This must be the **default** across every bot-posted message that
names a person, not a one-off per feature.

Slack renders `<@U…>` as `@Display Name` for the reader, so the message stays
readable while gaining the ping.

## Goal / non-goals

**Goal:** every text the bot *posts to Slack* that names a known person renders that
person as `<@ID>`, resolved deterministically from the curated `lib/people.ts`
registry.

**Non-goals:**
- Web / CSV / report-JSON surfaces never get mentions (they are internal and would
  show raw `<@ID>` codes). Verified: `formatDayMessage` output lives only in Slack
  message text + the `published` log, never in report artifacts.
- No live Slack directory fetch. Resolution is a pure function of the registry.
- No new registry data required — every field crew member already carries a
  `slackId` + `rosterInitial`, and developers carry `slackId`.

## Core: `lib/mention.ts` (new, pure)

A pure module (imports only `./people` and `./fieldRoster`, both pure — no
`server-only`, no `node:*`, so it is CLI- and client-bundle-safe).

### The name→slackId index

Built once from `PEOPLE`. For each person **that has a `slackId`**, register every
name form the person is referred to by across the console:

- canonical `name` — `"Taras Panasyuk"`
- every `alias` — `"Тарас Панасюк"`, `"Влад"`, `"Владислав"`, …
- the roster first-name from `resolveInitial(person.rosterInitial)` when
  `rosterInitial` is set — `"Тарас"`, `"Андріан"`, `"Сергій"`, `"Влад"`, …

Keys are matched **case-insensitively, trimmed**.

**Ambiguity rule:** if a key resolves to 2+ distinct people, it is **dropped from the
index** (never registered). We never guess-ping. (In the current registry the field
first-names are all unique; the deliberately-ambiguous shared names — Олександр,
Дмитро, Андрій — only appear as *full* aliases, so the bare first name either
resolves uniquely or is absent.)

### API

```ts
/** "<@ID>" if `name` resolves to exactly one person with a slackId; else `name`
 *  unchanged. On an unresolved/ambiguous name that is NOT an obvious non-person
 *  (see isLikelyPersonName), emit a console.warn so registry gaps surface. */
export function mentionize(name: string): string;

/** "<@ID>" when `person.slackId` is set, else `person.name`. For call sites that
 *  already hold a Person (sprint/Jira/GitHub group-by-identity). */
export function mention(person: Person): string;

/** Rewrite every "<@ID>" token in `text` back to the person's canonical display
 *  name (or leave the token if the id is unknown). For parse/display surfaces
 *  that must stay name-based. */
export function dementionText(text: string): string;
```

**Warn-on-miss (chosen behavior):** `mentionize` logs `console.warn` when a name
looks like a person name yet does not resolve (nudges maintainers to add an alias or
`slackId`). Obvious non-person tokens (drone categories like `"інші"`, `"15ка"`,
`"Демонстраційні"`) must NOT warn — a small `isLikelyPersonName` guard skips warning
for tokens that are numeric-leading, contain digits, or are known category words.
Warning is best-effort telemetry, never throws, never blocks a post.

## Apply sites (deterministic — Slack-post text only)

`mentionize`/`mention` applied at each render point. Categories and unknown names
fall through as plain text automatically.

| # | Site | Change |
|---|------|--------|
| 1 | `withRosterSuffix` (`👥 У полі:`) in `verdictPublish.ts` | mentionize each crew name |
| 2 | `formatDroneLine` (`🛸 Дрони:`) in `droneReport.ts` | mentionize **person** entries only; merge keys stay on raw name, mentionize at final term render in `droneTerms` |
| 3 | Acks — `applyRosterCorrection`, `applyApproval`, `applyInstruction`, `applyInstructionReply` | mentionize crew names + the `by` approver name |
| 4 | Sprint posts — `runSprint.ts` / `sprintReport.ts` | `mention(person)` for each assignee (code already resolves the Person via accountId) |
| 5 | Bonus thread notes — `bonusNotify.ts` / `field-bonus.ts` | mentionize names in the per-report thread post. **DMs already target `slackId` — unchanged.** |
| 6 | Loss / override acks — `proposalExecutor.ts`, `formatOverride` | mentionize the `by` approver name |

### Round-trip safety

- `parseRosterSuffix` (used by `fieldInstructionsReport.ts` / `GET /api/instructions`
  `--list`) runs `dementionText` on the parsed crew tokens so the Instructions view
  still shows human names, and any name-based idempotency comparison survives.
- `splitRosterSuffix` / `splitDroneLine` split on the `👥`/`🛸` markers and the
  trailing-line rule — `<@ID>` tokens contain no newline, so splitting is unaffected.
- `applyRosterCorrection` re-renders the crew suffix from `outcome.roster` (names)
  via `withRosterSuffix`, so once `withRosterSuffix` mentionizes, the re-render
  produces mentions consistently and the `updatedText === entry.text` idempotency
  check stays correct.

## Agent free-form replies (best-effort, lower confidence)

The conversational agent (`lib/agent/slackAgent.ts` → `/api/agent/run`) emits
LLM-generated prose that cannot be mechanically mentionized reliably. Add one line to
the agent system prompt instructing it to refer to people as `<@ID>` using the roster
when it names someone. This is **best-effort only** — the model may not comply or may
emit a wrong id; it is explicitly not guaranteed and not tested for exactness. The
deterministic structured posts above are the reliable path.

## Operational rollout

Changing the verdict message format changes every already-published message's
re-rendered text. After merge, run **once, manually**:

```
npm run field-backfill -- --publish --channel field-qa
```

to rewrite existing published verdicts to mention form in a single controlled pass
(per the documented backfill-before-nightly rule in CLAUDE.md). Skipping this makes
the next nightly try to re-edit the whole window at once and risk Vercel Hobby's 60s
function cap. `field-backfill` is idempotent and skips approver-overridden entries.

Note: editing a Slack message does **not** re-notify. Mentions ping only on the
original post — so the backfill rewrite of old messages pings no one, and future
nightly re-edits of a message never re-ping. Desired behavior.

## Testing

- **`lib/mention.test.ts` (new, pure):**
  - each name form (canonical, alias, roster first-name) resolves to `<@ID>`
  - a person without `slackId` → plain name
  - ambiguous key → plain name (not registered)
  - drone category (`"інші"`, `"15ка"`) → plain, **no warn**
  - unknown person-like name → plain, **warn emitted**
  - `dementionText` round-trips `<@ID>` → canonical name; unknown id left intact
  - `mention(person)` with/without slackId
- **Update existing tests** whose expected strings embed crew/drone names
  (`verdictPublish.test.ts`, `droneReport.test.ts`, ack tests in
  `applyInstruction.test.ts` etc.): expected crew/drone terms become `<@ID>` form.
  Prefer building the expected string from the same `mentionize` helper so the tests
  stay readable and registry-driven rather than hardcoding raw ids.

## Files touched (estimate)

New: `lib/mention.ts`, `lib/mention.test.ts`.
Edited: `lib/verdictPublish.ts`, `lib/droneReport.ts`, `lib/applyRosterCorrection.ts`,
`lib/applyApproval.ts`, `lib/applyInstruction.ts`, `lib/applyInstructionReply.ts`,
`lib/runSprint.ts` / `lib/sprintReport.ts`, `lib/bonusNotify.ts`,
`lib/proposalExecutor.ts`, `lib/agent/slackAgent.ts` (prompt nudge), and the affected
`*.test.ts` files. `scripts/fieldInstructionsReport.ts` reads the de-mentioned parse.
