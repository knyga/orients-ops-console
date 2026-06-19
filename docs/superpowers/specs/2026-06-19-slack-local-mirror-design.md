# Slack Local Mirror + Sync (S1) — Design

**Date:** 2026-06-19
**Status:** Approved (pending spec review)
**Sub-project:** S1 of the field-ops compliance agent
(`2026-06-19-fieldops-agent-architecture.md`). Foundation, read-only.

## Goal & scope

Build a **local, queryable, re-syncable on-disk copy** of the tracked Orients
Slack channels — the "conversation mirror" the agent loop
(`SYNC → DERIVE → VERDICT → ASK → INGEST → REMEMBER → PUBLISH`) calls memory.
Slack stays the source of truth; the mirror is a cache that can be rebuilt at any
time by re-running the sync.

S1 is **SYNC only — read + store**. It fetches every channel in
`TRACKED_CHANNELS` (including thread replies and bot messages), normalizes each
message, and writes it to disk keyed by `ts` so re-runs *upsert* rather than
duplicate. It exposes a read API (`readChannelMessages`) for downstream features.

**In scope (S1):**
- A pure mirror store (`lib/slackMirror.ts`): path/period helpers, read, and a
  pure merge/upsert/tombstone function.
- A thin, non-breaking addition to `lib/slack.ts` that returns *raw* messages
  including thread replies and edited/deleted flags.
- A `scripts/slack-sync.ts` CLI with **init**, incremental, and backfill modes,
  plus an `npm run slack-sync` entry under the `--conditions=react-server` runner.
- A `.gitignore` entry for the raw mirror directory.
- Unit tests for the pure store logic.

**Out of scope (S1) — these are later sub-projects:**
- No DERIVE / VERDICT / ASK / REMEMBER / PUBLISH. No flight-time extraction (S2),
  no acceptance verdict or resolutions store (S3), no outward posting (S4–S6).
- No bulk file downloads (metadata only; downstream downloads lazily).
- No web view / API route (the mirror is a CLI + on-disk artifact; a dashboard
  surface can come later).
- Refactoring existing consumers (`fetchMessages` callers) to read the mirror —
  noted as a later refactor in §"Reusing the mirror".

## House conventions honored (from CLAUDE.md + the existing specs)

- **Server-only secrets.** `lib/slack.ts` keeps `import "server-only"` and is the
  only module that reads `SLACK_TOKEN`. The CLI runs under
  `node --conditions=react-server --import tsx` so that import resolves to an
  empty module — same as `scripts/policy.ts`.
- **Pure, unit-tested `lib/`.** The merge/upsert/tombstone logic and the
  path/period helpers in `lib/slackMirror.ts` are pure (no React/Next, no secret)
  and Vitest-tested. The network fetch is **not** unit-tested (convention, like
  `lib/slack.ts` / `lib/jira.ts`).
- **`lib/slackMirror.ts` is NOT `server-only`** — like `lib/reports.ts`, it uses
  `node:fs` but holds no secret, so it's importable by both CLIs and (future)
  server components. `node:fs`'s absence in the browser bundle is the guard.
- **Relative imports in scripts** (`../lib/...`), no vitest path alias in tests
  (use relative imports + an injectable `baseDir`, mirroring `lib/reports`).
- **Two interfaces eventually**, but S1 ships the CLI + artifact half only.

## Git policy (decided)

The **raw mirror is git-ignored** — it is high-volume, contains PII (real
messages, names, private file URLs), and is fully re-syncable from Slack. Only
**derived artifacts** (S2+) and the future **resolutions store** (S3/S6) get
committed — low-volume, auditable decisions. This is the same split as today:
`reports/` committed vs `.env` local.

S1 adds to `.gitignore`:

```
# slack raw mirror (re-syncable from Slack; PII + volume)
data/slack/
```

(If a local file cache is added later — see §Files — `data/slack-files/` is also
git-ignored.)

## Storage layout & format

```
data/slack/<channel-name>/<YYYY-MM>.json
```

- `<channel-name>` is the tracked channel **name** (`field-qa`, `datasets`, …)
  from `lib/slackChannels.ts` — already what `SlackMessage.channel` carries and
  what downstream consumers match on. (We store by name, not id, for greppability
  and consistency with the existing normalized shape; the id→name map is in
  `slackChannels.ts`.)
- One file **per channel per calendar month**, keyed off each message's day
  (derived from `ts`, UTC — consistent with the rest of the repo's calendar math).

**File shape:** a JSON object keyed by `ts` (NOT an array), so upsert is an
O(1) key write and re-sync of an edited message overwrites in place:

```jsonc
{
  "version": 1,
  "channel": "field-qa",
  "month": "2026-06",
  "messages": {
    "1716200000.000200": { /* StoredMessage */ },
    "1716200500.000300": { /* StoredMessage */ }
  }
}
```

### Stored record shape (`StoredMessage`)

Borrows/extends the normalized `SlackMessage` (`lib/policySchedule.ts`) so
downstream code that already speaks `SlackMessage` reads the mirror with minimal
adaptation. Added fields are mirror-specific bookkeeping:

```ts
interface StoredMessage {
  ts: string;            // Slack ts — the key; also stored for convenience
  channel: string;       // tracked channel NAME
  authorId: string;      // m.user ?? m.bot_id
  author: string;        // resolved display name (or bot_id/"bot")
  isoTime: string;       // ISO 8601 from ts
  text: string;
  permalink: string;
  files?: SlackFile[];   // METADATA only (name, mimetype, urlPrivate) — see §Files
  thread_ts?: string;    // present on replies AND on parents that have replies
  reply_count?: number;  // from Slack, on the thread parent
  edited?: string;       // edit marker: the message's `edited.ts` when Slack reports it
  deleted?: boolean;     // tombstone — see §Consistency model
  firstSeen: string;     // ISO — when this record first entered the mirror
  lastSeen: string;      // ISO — last sync run that observed it present in Slack
}
```

Notes:
- `thread_ts === ts` for a thread parent; `thread_ts !== ts` for a reply.
  A reply is just another `StoredMessage` keyed by **its own** `ts`, carrying the
  parent's `thread_ts`. This is what makes "remember answers" (S6) possible — the
  bot's S5 question is a parent, the human's reply is a child record under the
  same `thread_ts`.
- `edited` lets a consumer notice "this message changed since I last looked".
- `deleted: true` is a tombstone — the record is kept (with its last-known text)
  so downstream evidence/permalinks don't silently vanish; consumers filter it
  out where appropriate.

### Why JSON-per-channel-per-month

- **Scale.** Five channels × a handful of active months × hundreds–low-thousands
  of messages/month is small. A whole month-file is a few hundred KB; reading and
  rewriting it on each sync is trivial.
- **Upsert-friendly.** Keying by `ts` inside one object makes
  edit-capture/tombstoning a pure map merge. NDJSON-append would *grow* on every
  re-fetch of the trailing window (the same `ts` re-appended), forcing a separate
  compaction pass and making "current state" ambiguous — exactly what we want to
  avoid given we re-fetch a trailing window every run.
- **Git-ignored + greppable.** It's never committed, so churn/diff-noise isn't a
  concern; meanwhile a human (or a quick `jq`/`grep`) can open one month of one
  channel directly. SQLite would be queryable too but adds a binary dependency,
  isn't greppable, and is overkill at this volume; it can be revisited if the
  mirror grows orders of magnitude.
- **Month sharding** bounds file size and makes period reads cheap (open only the
  months a period touches — same `monthsInPeriod` idea already in
  `lib/policySchedule.ts`).

## Consistency model

Slack messages can be **edited** and **deleted**, and threads grow after the
parent was first seen. A one-shot "fetch [start,end] once" sync would miss all of
these. The model:

- **Per-channel cursor.** A small sidecar per channel records the last successful
  sync time:

  ```
  data/slack/<channel-name>/_sync.json   →  { "lastSync": "<ISO>", "version": 1 }
  ```

  (Underscore prefix keeps it out of the `YYYY-MM` month-file glob.)

- **Trailing re-fetch window.** Each incremental run fetches
  `[lastSync − WINDOW_DAYS, now]` (default `WINDOW_DAYS = 7`, configurable via
  `--window N`). This catches edits/deletes to recent messages **and** everything
  newer in one pass. Older history is assumed stable (edits to month-old messages
  are rare; a full re-check is the backfill mode's job).

- **Upsert by `ts`.** For each fetched message, merge into the month-file's
  `messages[ts]`: create with `firstSeen=now` if new; otherwise overwrite the
  mutable fields (`text`, `edited`, `files`, `reply_count`) and set
  `lastSeen=now`. Clear any stale `deleted` flag if the message reappears.

- **Deletion detection within the window.** After fetching, for each month-file
  touched by the re-fetch window, compute the set of stored `ts` whose `isoTime`
  falls inside `[windowStart, now]`. Any stored ts in that set that was **not**
  present in this run's fetch result is marked `deleted: true` (tombstone). We
  only tombstone **inside the re-fetch window** — we never infer deletion for
  messages older than the window (we didn't ask Slack about them, so absence
  proves nothing).

- **Init mode (`init`).** The first-run / reset command. Equivalent to a backfill
  whose floor is the **first day of the current calendar month** (Europe/Kyiv —
  matches S2's field-day boundaries; month-*file bucketing* stays UTC, the floor
  is only a fetch start). It fetches `[<this-month>-01, now]` for every tracked
  channel, walks threads, upserts, does **not** tombstone (additive), and sets
  `lastSync = now` per channel so the next plain run is incremental. Re-running
  `init` when a cursor already exists is safe (upsert converges) but prints a
  notice that plain `slack-sync` is the incremental path. This makes the very
  first `npm run slack-sync init` produce a usable current-month mirror with zero
  ceremony, and resolves the "what floor?" question for the common case.

- **Backfill mode (`--backfill [--since YYYY-MM-DD]`).** The "reach further back
  into history" escape hatch beyond what `init` pulls: fetch from `--since`
  (default: the start of the current calendar month, same floor as `init`) up to
  `now`, upserting every message and walking every thread. Backfill does **not**
  tombstone (it's additive — absence over a huge range is not reliable deletion
  signal). It sets `lastSync = now` per channel on success so the next incremental
  run takes over.

### Incremental sync algorithm (per channel, concrete)

1. Read `_sync.json` → `lastSync`. If absent ("never synced"), **auto-run init**
   for this channel (floor = first of the current calendar month) and print a
   one-line notice, rather than erroring — so a bare `npm run slack-sync` works on
   a fresh checkout. Explicit `init` always uses the current-month floor
   regardless of cursor state.
2. `windowStart = max(lastSync − WINDOW_DAYS, floor)`; `windowEnd = now`.
3. Fetch raw history for `[windowStart, windowEnd]` (paged, `cache:"no-store"`).
4. For each parent with `reply_count > 0` / a `thread_ts`, fetch
   `conversations.replies` and include the replies (see §Threads).
5. Load the affected month-files (those whose `YYYY-MM` the window spans).
6. **Upsert** every fetched message (parent + replies) by `ts`.
7. **Tombstone**: stored ts inside `[windowStart, windowEnd]` and absent from the
   fetch result → `deleted: true`.
8. Write the affected month-files atomically (write temp + rename).
9. On full success, set `_sync.json.lastSync = now`. On per-channel failure, do
   **not** advance that channel's cursor (so the next run retries the same
   window) — see §Error handling.

The upsert + tombstone steps (5–7) are the **pure, unit-tested** core; steps
3–4 (network) and 8–9 (fs/cursor) are the I/O shell.

## Threads

`conversations.history` returns thread **parents** only — replies are not in the
history stream. A message is a thread root when it has `reply_count > 0` (Slack
also sets `thread_ts === ts` on such parents). For each such parent in the
fetched window, call `conversations.replies(channel, ts)` (paged) to get the
replies; each reply has its own `ts` and a `thread_ts` pointing at the parent.

- Replies are stored as ordinary `StoredMessage` records, keyed by **their own
  `ts`**, carrying `thread_ts`. They land in the month-file of the reply's own
  date (a reply made in July to a June parent lives in the July file) — keying is
  by `ts` regardless, so this is consistent and reconstructable by `thread_ts`.
- A reply within the trailing window participates in tombstone detection like any
  other message.
- This is the mechanism S6 ("ingest + remember answers") depends on: the bot's
  S5 question is a parent; the human's free-text reply is a child record under the
  same `thread_ts`, which the classifier reads from the mirror.

## Files

Store file **metadata only** in `StoredMessage.files[]` — `name`, `mimetype`,
`urlPrivate` — exactly the `SlackFile` shape from `lib/policySchedule.ts`,
produced by the existing pure `toSlackFiles` mapper. Do **not** bulk-download.

- Downstream features download lazily and on demand via the existing
  `downloadFileBase64(urlPrivate)` in `lib/slack.ts` (e.g. S2 reads a single
  stats-bot image when it needs that day's flight time).
- `urlPrivate` requires the bot token to fetch, so it is itself mildly sensitive
  — another reason the raw mirror is git-ignored.
- **Optional local file cache (deferred).** A future `data/slack-files/` (also
  git-ignored) could memoize downloaded bytes keyed by file id to avoid
  re-downloading. Not part of S1; flagged as an open question because it trades
  disk for fewer Slack file fetches and most files are read at most once.

## Module / CLI design

### `lib/slackMirror.ts` (the store — NOT server-only, pure logic isolated)

Path / period helpers (mirroring `lib/reports.ts` discipline, with an injectable
`baseDir`):

- `defaultBaseDir(): string` → `join(process.cwd(), "data", "slack")`.
- `interface MirrorOpts { baseDir?: string }`.
- `monthFilePath(channel, month, opts?)`, `syncFilePath(channel, opts?)`.
- `monthsInPeriod(period)` — distinct `YYYY-MM` touched (reuse the existing idea).

I/O:

- `readMonthFile(channel, month, opts?): MonthFile | null` (null when absent).
- `writeMonthFile(channel, month, file, opts?)` — atomic (temp + rename), mkdir -p.
- `readChannelMessages(channel, period, opts?): StoredMessage[]` — reads the
  month-files a period spans, concatenates `messages` values, filters by
  `isoTime ∈ [start,end]`, sorts by `ts`. (The downstream read API — see
  §Reusing the mirror.)
- `readSyncCursor(channel, opts?)` / `writeSyncCursor(channel, iso, opts?)`.

**Pure core (the unit-tested heart):**

- `mergeMessages(existing: Record<string, StoredMessage>, fetched:
  StoredMessage[], windowStart: string, now: string): Record<string,
  StoredMessage>` — does upsert (preserve `firstSeen`, refresh mutable fields +
  `lastSeen`, clear stale `deleted`) **and** tombstoning (stored ts inside
  `[windowStart, now]` absent from `fetched` → `deleted:true`). No fs, no clock
  reads — `now`/`windowStart` are passed in, so it's deterministic and testable.

This split keeps the merge/tombstone policy in one pure function while the
file-shaped wrappers (`upsertMonth`) just glue it to `read/writeMonthFile`.

### `lib/slack.ts` (thin, non-breaking addition)

Add a raw fetch that returns messages **including thread replies and
edited/deleted markers**, WITHOUT changing the existing `fetchMessages` signature
or behavior (its current callers — `scripts/policy.ts`, the policy route — must be
untouched):

```ts
export interface RawSlackMessage {
  channel: string;        // tracked NAME
  ts: string;
  authorId: string;
  author: string;
  isoTime: string;
  text: string;
  permalink: string;
  files?: SlackFile[];
  thread_ts?: string;
  reply_count?: number;
  edited?: string;        // from raw `edited.ts`
}

// New, additive. Returns parents + thread replies for [period], for the given
// channels (defaults to TRACKED_CHANNELS), each normalized as above.
export async function fetchRawMessages(
  period: Period,
  channels?: SlackChannel[],
): Promise<RawSlackMessage[]>;
```

Implementation reuses the existing private machinery: `token()`, `userMap()`,
`epoch()`, `permalink()`, the `call<T>()` pager, the
`!m.user && !m.bot_id` skip, and `authorId = m.user ?? m.bot_id`. It additionally
(a) reads `edited.ts` and `reply_count`/`thread_ts` off the raw history rows, and
(b) for each parent with replies, pages `conversations.replies` and appends those
rows. `fetchMessages` can optionally be re-expressed as a thin projection of
`fetchRawMessages` (drop the extra fields) — *only if* it leaves the public
`SlackMessage` output byte-identical; otherwise leave `fetchMessages` exactly as
is to avoid regressions. The CLI maps `RawSlackMessage → StoredMessage` (add
`firstSeen`/`lastSeen`/`deleted`).

Deletion is **not** a per-message flag from `conversations.history` (deleted
messages simply don't appear); the `deleted` tombstone is derived by
`mergeMessages`, not read from Slack. `edited` *is* a real Slack field.

### `scripts/slack-sync.ts` (CLI)

```
npm run slack-sync -- init                  # first run / reset: backfill from start of current month
npm run slack-sync                          # incremental, all tracked channels, default window
                                            #   (auto-runs init per channel if it has no cursor yet)
npm run slack-sync -- --window 14           # widen the trailing re-fetch window
npm run slack-sync -- --backfill --since 2026-02-01   # reach further back into history
npm run slack-sync -- --channel field-qa    # restrict to one channel (combinable with any mode)
```

Behavior (mirrors `scripts/policy.ts` structure):
- `process.loadEnvFile()` in a try/catch; `parseArgs(process.argv.slice(2))`.
- Resolve mode (`init` / incremental / `--backfill`) and per-channel windows;
  `init` and `--backfill` share the current-month floor as their default `--since`.
- For each channel: compute window, `fetchRawMessages`, map to `StoredMessage`,
  `mergeMessages` into each affected month-file, write atomically, advance the
  cursor — all wrapped so one channel's failure doesn't abort the others.
- Print a per-channel summary to stderr (fetched / new / updated / tombstoned),
  exit non-zero if any channel failed.

`package.json` gains:

```json
"slack-sync": "node --conditions=react-server --import tsx scripts/slack-sync.ts"
```

## Reusing the mirror (later — not S1)

Downstream sub-projects read the mirror instead of hitting live Slack via
`readChannelMessages(channel, period)`:

- **S2** (flight time) reads `field-qa` for a day, finds the stats-bot summary
  message + its image file metadata, and downloads that one image lazily.
- **S3/S6** read thread replies under the bot's questions to learn resolutions.
- Existing live consumers (`fetchMessages` in the policy feature) could be
  refactored to read the mirror for closed periods and only hit Slack for the
  current window — **explicitly a later refactor**, not in S1, so S1 ships without
  touching working behavior.

## Error handling, idempotency, rate limits

- **Idempotent / re-runnable.** Upsert + tombstone make re-running safe: the same
  window twice converges to the same state (no duplication; `firstSeen` is
  preserved; `lastSeen` advances).
- **Per-channel isolation.** Each channel is synced independently; a failure
  (network, scope error, one bad channel) is caught, logged, and does **not**
  advance that channel's cursor or abort the others — the next run retries that
  channel's window. The CLI exits non-zero if any channel failed.
- **Atomic writes.** Month-files are written temp-then-rename so an interrupted
  run never leaves a half-written JSON.
- **Cursor advances only on success** for a channel, so progress is never lost
  and a partial run is safely resumed.
- **Slack paging / backoff.** Reuse the existing `call<T>()` cursor pager. Add
  handling for HTTP `429` with `Retry-After` (sleep + retry) in the shared
  `call`/fetch path, since backfill + thread-walking issue many more calls than
  the policy feature; keep `cache:"no-store"`. `SlackError` semantics
  (502 upstream / 500 config) are preserved.

## Testing

Pure logic only (Vitest, relative imports, injectable `baseDir` for a temp dir —
same pattern as `lib/reports` tests). Network fetch is **not** unit-tested
(convention).

`lib/slackMirror.test.ts`:
- `mergeMessages`: new message inserted with `firstSeen`/`lastSeen` set.
- `mergeMessages`: edited message overwrites `text`/`edited`, **preserves
  `firstSeen`**, advances `lastSeen`.
- `mergeMessages`: stored ts inside the window absent from fetch → `deleted:true`.
- `mergeMessages`: stored ts **outside** the window absent from fetch → untouched
  (never tombstoned).
- `mergeMessages`: a previously-tombstoned ts reappearing → `deleted` cleared.
- `mergeMessages`: a thread reply (own ts, `thread_ts` of parent) upserts
  independently of the parent.
- Path helpers: `monthFilePath` / `syncFilePath` honor `baseDir`;
  `monthsInPeriod` returns the right `YYYY-MM` set for a cross-month period.
- Round-trip: `writeMonthFile` then `readMonthFile` is identity; `readMonthFile`
  of a missing file → `null`.
- `readChannelMessages`: reads across month boundaries, filters by `[start,end]`,
  excludes records outside the period, sorts by `ts`.
- Sync cursor: `read`/`write` round-trips; reading a missing cursor → null.

Not tested: `scripts/slack-sync.ts` (orchestration/IO), `lib/slack.ts`'s
`fetchRawMessages` (network).

`npm test` / `npm run lint` / `npx tsc --noEmit` clean.

## Conventions & open questions

- **Server-only boundary** unchanged: secret-reading stays in `lib/slack.ts`
  (`server-only`); `lib/slackMirror.ts` is fs-only and secret-free; the CLI runs
  under `--conditions=react-server`.
- **`.gitignore`** gains `data/slack/` (and `data/slack-files/` if the file cache
  lands). Confirm no other tooling expects `data/` to be committed.

Open questions to confirm before/with implementation:
1. **Trailing window size** — default `WINDOW_DAYS = 7`. Big enough to catch
   typical late edits? (Edits to messages older than a week are rare but not
   impossible; backfill re-checks everything.)
2. **Backfill floor / `--since` default** — *resolved:* both `init` and a
   `--since`-less `--backfill` floor at the **first day of the current calendar
   month** (Europe/Kyiv). Going further back is an explicit `--backfill --since`.
3. **Local file cache** (`data/slack-files/`) — worth it given most files are
   read at most once? (Deferred; metadata-only for S1.)
4. **Retention / pruning** of very old month-files — none in S1 (volume is small);
   revisit only if disk becomes a concern.
5. **Store by channel name vs id** — this spec stores by **name** (greppable,
   matches the normalized shape). Renaming a tracked channel would orphan old
   dirs; acceptable given names are stable and the mirror is re-syncable.
