# `who` — person-centric activity view

**Date:** 2026-06-30
**Status:** Design (approved, pre-implementation)

## 1. Purpose & scope

One command and one dashboard tab that answer *"what has this person been doing and
saying?"* for a period, by joining everything the console already knows about a single
human across its data sources.

The console's per-person knowledge is currently scattered across five features (Slack
mirror, Jira, GitHub, #field-qa flight-hours, field-bonus). Answering a person-centric
question today means running five commands and stitching the result together by hand.
`who` is the one read that does the join.

**The Slack mirror is the timestamped spine.** It is the only source that is rich,
per-message, locally stored, and already timestamped. Jira / GitHub / #field-qa /
field-bonus attach as **compact period summaries** (counts + keys), because the committed
artifacts for those features are per-person aggregates, not timestamped event streams.

**All reads are local at query time** — the Slack mirror plus committed/DB report
artifacts. `who` makes **no live API calls** when answering. (The one exception is the
seeding tool in §3, which is a separate, human-driven command, not part of answering a
`who` query.)

Default period: the current Kyiv month, consistent with every other feature.

### Out of scope (YAGNI)

This spec builds **only `who`**. The two sibling ideas from the original recall cluster —
`recall` (semantic search over the Slack mirror) and `why` (per-flight-day verdict
decision-trail) — are deliberately deferred to their own future specs. Both build on the
identity layer (`lib/people.ts`) this spec establishes; designing them now would add scope
before it is needed.

## 2. Identity layer (the heart of the feature)

The hard problem `who` solves is **identity**: the same human appears as a Slack
`authorId`, a Jira assignee, a GitHub login, and a Cyrillic initial in #field-qa, and these
four namespaces have no existing bridge between them. The field-operator population
(#field-qa) and the developer population (Jira/GitHub) barely overlap — only leadership
spans both — so name-based guessing would silently mis-join people. That is precisely the
"distrust human-written content" failure mode the console exists to avoid.

### `lib/people.ts` — hardcoded, auditable registry

Modeled on `lib/approvers.ts` and `lib/slackChannels.ts`: membership is a deliberate,
version-controlled, reviewable decision — **not** runtime config and **not** name-matched
on the fly.

```ts
export interface Person {
  name: string;            // canonical display name
  role: string;            // e.g. "CEO/CTO", "field operator", "developer"
  slackId?: string;        // U… — joins the Slack timeline
  jiraAccount?: string;    // joins the Jira summary
  githubLogin?: string;    // joins the GitHub summary
  rosterInitial?: string;  // Cyrillic initial — joins #field-qa + bonus
}

export const PEOPLE: Person[] = [ /* … */ ];
```

Every external-id field is **optional**: a field operator may have only `rosterInitial`
(+ `slackId`); a developer may have only `jiraAccount` + `githubLogin`. A person is joined
to a source only when the matching field is present.

The module is **pure** (no DB/Next imports — `PEOPLE` is a literal) and exposes pure
resolver helpers, unit-tested in isolation:

- `personByQuery(q: string): { person: Person } | { ambiguous: Person[] } | { unknown: string }`
  — resolves the CLI `--person` argument. Case-insensitive exact-name match first, then
  unique substring match; multiple substring hits return `ambiguous` (caller lists
  candidates); no hit returns `unknown`.
- `personForSlackId(id)`, `personForGithubLogin(login)`, `personForJiraAccount(acct)`,
  `personForInitial(initial)` — reverse lookups (each returns `Person | undefined`), used by
  both the join and the unlinked-identity hygiene check.

### Seeding — `npm run people:scaffold` (`scripts/people.ts`)

An assisted, human-driven seeding aid — **never** a runtime resolver, and it **never writes
`lib/people.ts`**:

- Reads the live Slack `users.list` (server-only client + `--conditions=react-server`
  discipline, like the other CLIs), the committed Jira and GitHub reports (visible
  accounts/logins), and the roster (`lib/fieldRoster.ts` initials).
- Best-effort matches these by display name and **prints proposals with a confidence
  label** (e.g. `confidence: name` for a name-only match) to stdout.
- A human reviews the proposals and pastes the confirmed entries into `lib/people.ts`.

This honors "auto-reconcile to seed" while keeping the committed registry the reviewed
source of truth — the scaffold proposes, a human disposes, no silent mis-joins reach the
join path.

### Hygiene — `who --unlinked`

Lists every Slack `authorId`, Jira account, GitHub login, and roster initial that appears in
the period's data but is claimed by **no** `Person`. Gaps surface as data (a to-do list for
the registry) rather than as silent omissions from someone's timeline.

## 3. Data assembly — pure `lib/who.ts`

The shaping logic lives in a pure module (no `node:fs`, no Next imports), so the CLI and the
web route consume the same code path, and it is unit-tested like `lib/reconcile.ts`. The
orchestrator (CLI / API route) reads the sources and passes them in.

```ts
buildPersonView(person: Person, period: Period, sources: WhoSources): PersonView
```

- **`sources.slackMessages`** — `StoredMessage[]` already read from the mirror (all tracked
  channels, via `readChannelMessages` per channel).
- **`sources.reports`** — the period's committed/DB report JSON for jira / github / field-qa
  / field-bonus (each may be `null` if not committed for the period), read via
  `readReportJson(feature, key)`.

`PersonView`:

```ts
interface PersonView {
  person: Person;
  period: Period;
  timeline: TimelineEntry[];   // { ts, isoTime, channel, text, permalink }
  summary: {
    jira?:   { issueKeys: string[]; count: number; points: number };
    github?: { commits: number; additions: number; deletions: number;
               prsOpened: number; prsMerged: number };
    field?:  { trips: number; flightDays: number; flightMinutes: number;
               netUah: number };
  };
}
```

Identity → source matching:

| Source        | Report (committed/DB) | Matched on                                   |
| ------------- | --------------------- | -------------------------------------------- |
| Slack         | `schema.slackMessages`| `authorId === person.slackId`                |
| jira summary  | `jira`                | `UserRow.accountId === person.jiraAccount`   |
| github summary| `github`              | contributor `login === person.githubLogin`   |
| field summary | `field-bonus`         | roster name (from `person.rosterInitial`)    |

There is **no per-person #field-qa source**: the committed `field-qa` report is a per-day
aggregate (`{date, flightHours, airborneMinutes, flights}`) with no operator dimension. The
per-person field picture lives in the **field-bonus** report instead: `people[]` is
`PersonBonus[]` keyed by roster *name* (`{name, trips, net, …}`), and `days[]` carries
`roster: string[]` + `deployMin`/`videoMin`. So the single `field` summary block is built
from the field-bonus report — `netUah`/`trips` from the person's `PersonBonus`,
`flightDays`/`flightMinutes` by summing `days[]` where `roster` includes the person.

The roster name is resolved from `person.rosterInitial` via `resolveInitial`
(`lib/fieldRoster.ts`) — note `person.name` is the canonical display name (e.g.
"Oleksandr K"), which is *not* the Cyrillic roster name (e.g. "Олександр"); the join is by
roster name, not display name.

Assembly rules:

- **timeline**: keep messages authored by this person — `authorId === person.slackId`. Sort
  ascending by `isoTime` (`ts`). Drop tombstoned (`deleted`) messages. (#field-qa authorship
  is by Slack `authorId` like every other channel; the Cyrillic *initials inside* a report's
  text are a per-day roster, not the message author, so they are not used for timeline
  attribution.)
- **summary blocks**: each block is populated **only if** the person carries the matching
  identity field **and** a committed report exists for the period. A missing identity or a
  missing report → the block is simply absent (the console's "committed by default, no live
  fetch" convention). `who` never triggers a live recompute to fill a gap.

## 4. CLI surface — `npm run who`

```
npm run who -- --person <query> --start YYYY-MM-DD --end YYYY-MM-DD [--format table] [--unlinked]
```

- JSON by default — the exact shape `GET /api/who` returns.
- `--format table` — human-readable: the timeline as time-ordered rows, then the summary
  blocks.
- `--person` resolves via `personByQuery`; `ambiguous` → exit non-zero listing candidate
  names; `unknown` → exit non-zero with the registry's names.
- `--unlinked` — ignore `--person` and print the unlinked-identity report for the period.
- Period defaults to the current Kyiv month when `--start`/`--end` are omitted.
- **No `--write`**: `who` is a read-only view and persists no `reports/` artifact. (It is a
  reader of other features' artifacts, not a producer of its own.)

## 5. Web surface — new **People** tab

CLAUDE.md requires every feature to ship a web representation as a first-class peer of the
CLI.

- Nav: add `{ href: "/people", label: "People", enabled: true }` to `TABS` in
  `app/(dashboard)/layout.tsx`.
- `GET /api/who?person=<query>&period=<key>` — serves the `PersonView` JSON; 404 on unknown
  person, 400 on ambiguous (body lists candidates). `?people=1` returns the registry's
  person names (for the picker). Reads committed artifacts only — no `?refresh=1` live path,
  because `who` is committed-only by design.
- Page `app/(dashboard)/people/page.tsx`: a person picker + a period picker, rendering a
  timeline column (channel-tagged, time-ordered, permalinked rows) beside summary cards
  (Jira / GitHub / field-qa / bonus — only the present ones). Follows the shared
  `usePeriodReport` hybrid pattern (committed-by-default; no live refresh button, since there
  is no live path).

## 6. Testing

The repo's discipline — logic lives in pure `lib/` modules with unit tests:

- `lib/people.test.ts` — `personByQuery` (exact, unique-substring, ambiguous, unknown);
  reverse lookups; optional-field handling.
- `lib/who.test.ts` — timeline filter (by `authorId`) + merge + sort across channels;
  tombstone exclusion; jira/github/field summary attach when identity+report present; field
  block built from field-bonus by roster name resolved from `rosterInitial`; block absence
  when identity missing or report missing; `--unlinked` detection (identities in data but not
  in the registry).
- Scaffold matching is pure and tested; the live `users.list` fetch is a thin, untested
  shell (consistent with the other CLIs).

## 7. Files touched

- **New**: `lib/people.ts`, `lib/people.test.ts`, `lib/who.ts`, `lib/who.test.ts`,
  `scripts/people.ts` (scaffold), `scripts/who.ts` (CLI), `app/api/who/route.ts`,
  `app/(dashboard)/people/page.tsx` (+ any small client component for the picker).
- **Edited**: `app/(dashboard)/layout.tsx` (nav tab), `package.json` (`who` + `people:scaffold`
  scripts; `who`/scaffold run Node with `--conditions=react-server` like the other
  server-only-backed CLIs), `CLAUDE.md` (Commands section entry), and a `.claude/skills/who/`
  skill so the feature is Claude-Code-first.

## 8. Open dependencies / assumptions

- Field operators and developers are largely disjoint populations; most people will have a
  subset of identity fields, and that is expected, not an error.
- The committed/DB Jira/GitHub/field-qa/field-bonus reports for a period must exist for those
  summary blocks to appear; `who` does not compute them. This matches the hybrid convention
  and keeps `who` a pure reader.
