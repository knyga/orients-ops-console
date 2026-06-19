# Slack Local Mirror + Sync (S1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local, queryable, re-syncable on-disk mirror of the tracked Orients Slack channels (`data/slack/<channel>/<YYYY-MM>.json`), driven by a `slack-sync` CLI with `init` / incremental / `--backfill` modes.

**Architecture:** A pure, unit-tested store (`lib/slackMirror.ts`: path helpers + `upsertMessages`/`mergeMessages` merge-and-tombstone core + month-file/cursor I/O with an injectable `baseDir`), a non-breaking additive raw fetch on the server-only `lib/slack.ts` (`fetchRawMessages`, including thread replies + edit markers), and a `scripts/slack-sync.ts` CLI that runs under `--conditions=react-server`. The raw mirror is git-ignored.

**Tech Stack:** TypeScript (strict), Node `node:fs`, Vitest, the Slack Web API (`conversations.history`/`conversations.replies`), tsx. Mirrors the existing `lib/reports.ts` + `scripts/policy.ts` discipline.

**Spec:** `docs/superpowers/specs/2026-06-19-slack-local-mirror-design.md`

---

## File structure

| File | Responsibility | Tested |
|---|---|---|
| `lib/slackMirror.ts` (create) | Pure store: types, path/period helpers, `upsertMessages`, `mergeMessages` (tombstone), month-file + cursor I/O, `readChannelMessages`. NOT `server-only`. | ✅ unit |
| `lib/slackMirror.test.ts` (create) | Vitest for the store (injectable `baseDir` + tmpdir). | — |
| `lib/slack.ts` (modify) | Add `RawSlackMessage` + `fetchRawMessages` (history + thread replies + `edited`); add 429/Retry-After retry to the shared `call`. `fetchMessages` untouched. | network → not unit-tested |
| `scripts/slackSyncArgs.ts` (create) | Pure CLI shaping: `parseArgs`, `firstOfMonth`, `subtractDaysIso`. | ✅ unit |
| `scripts/slackSyncArgs.test.ts` (create) | Vitest for the arg/window helpers. | — |
| `scripts/slack-sync.ts` (create) | CLI orchestration: per-channel init/incremental/backfill, isolation, summary. | manual (live Slack) |
| `package.json` (modify) | Add `"slack-sync"` script. | — |
| `.gitignore` (modify) | Add `data/slack/`. | — |

**Canonical types (defined in Task 1, referenced everywhere):**

```ts
// lib/slackMirror.ts
import type { SlackFile } from "./policySchedule";
import type { Period } from "./period";

export interface StoredMessage {
  ts: string;            // Slack ts — the map key; also stored for convenience
  channel: string;       // tracked channel NAME
  authorId: string;      // m.user ?? m.bot_id
  author: string;        // resolved display name (or bot_id/"bot")
  isoTime: string;       // ISO 8601 from ts
  text: string;
  permalink: string;
  files?: SlackFile[];   // METADATA only
  thread_ts?: string;    // present on replies AND on parents that have replies
  reply_count?: number;  // from Slack, on the thread parent
  edited?: string;       // the message's `edited.ts` when Slack reports an edit
  deleted?: boolean;     // tombstone (derived, never read from Slack)
  firstSeen: string;     // ISO — when this record first entered the mirror
  lastSeen: string;      // ISO — last sync run that observed it present
}

export interface MonthFile {
  version: 1;
  channel: string;
  month: string;         // YYYY-MM
  messages: Record<string, StoredMessage>;
}

export interface SyncCursor {
  version: 1;
  lastSync: string;      // ISO
}

export interface MirrorOpts {
  baseDir?: string;
}
```

---

### Task 1: Mirror types + path/period helpers + git-ignore

**Files:**
- Create: `lib/slackMirror.ts`
- Create: `lib/slackMirror.test.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Write the failing test for path/period helpers**

Create `lib/slackMirror.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  monthFilePath,
  monthsInPeriod,
  syncFilePath,
} from "./slackMirror";

describe("path + period helpers", () => {
  it("monthFilePath / syncFilePath honor baseDir and channel name", () => {
    const base = "/tmp/mirror";
    expect(monthFilePath("field-qa", "2026-06", { baseDir: base })).toBe(
      "/tmp/mirror/field-qa/2026-06.json",
    );
    expect(syncFilePath("field-qa", { baseDir: base })).toBe(
      "/tmp/mirror/field-qa/_sync.json",
    );
  });

  it("monthsInPeriod returns the distinct YYYY-MM set a period spans", () => {
    expect(monthsInPeriod({ start: "2026-05-28", end: "2026-07-02" })).toEqual([
      "2026-05",
      "2026-06",
      "2026-07",
    ]);
    expect(monthsInPeriod({ start: "2026-06-01", end: "2026-06-30" })).toEqual([
      "2026-06",
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/slackMirror.test.ts`
Expected: FAIL — `Failed to resolve import "./slackMirror"` / functions not defined.

- [ ] **Step 3: Create `lib/slackMirror.ts` with types + helpers**

```ts
/**
 * Local Slack mirror store — the on-disk, re-syncable copy of the tracked
 * channels. NOT `server-only`: it uses node:fs but holds no secret, so both the
 * CLI and (future) server components can import it; node:fs's absence in the
 * browser bundle is the guard. Same precedent as ../lib/reports.
 *
 * Layout: data/slack/<channel-name>/<YYYY-MM>.json (messages keyed by ts) plus a
 * per-channel _sync.json cursor. The pure merge/tombstone core (upsertMessages,
 * mergeMessages) is unit-tested; the fs wrappers take an injectable baseDir.
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Period } from "./period";
import type { SlackFile } from "./policySchedule";

export interface StoredMessage {
  ts: string;
  channel: string;
  authorId: string;
  author: string;
  isoTime: string;
  text: string;
  permalink: string;
  files?: SlackFile[];
  thread_ts?: string;
  reply_count?: number;
  edited?: string;
  deleted?: boolean;
  firstSeen: string;
  lastSeen: string;
}

export interface MonthFile {
  version: 1;
  channel: string;
  month: string;
  messages: Record<string, StoredMessage>;
}

export interface SyncCursor {
  version: 1;
  lastSync: string;
}

export interface MirrorOpts {
  baseDir?: string;
}

/**
 * Repo-root data/slack directory. Resolved from process.cwd() (the npm CLIs and
 * next both launch from the repo root) — same rationale as reports.defaultBaseDir.
 */
export function defaultBaseDir(): string {
  return join(process.cwd(), "data", "slack");
}

function channelDir(channel: string, opts?: MirrorOpts): string {
  return join(opts?.baseDir ?? defaultBaseDir(), channel);
}

/** Absolute path to a channel's month file (data/slack/<channel>/<YYYY-MM>.json). */
export function monthFilePath(channel: string, month: string, opts?: MirrorOpts): string {
  return join(channelDir(channel, opts), `${month}.json`);
}

/** Absolute path to a channel's sync cursor (data/slack/<channel>/_sync.json). */
export function syncFilePath(channel: string, opts?: MirrorOpts): string {
  return join(channelDir(channel, opts), "_sync.json");
}

/** Distinct YYYY-MM month prefixes a period spans, in ascending order. */
export function monthsInPeriod(period: Period): string[] {
  const seen = new Set<string>();
  const date = new Date(`${period.start}T00:00:00.000Z`);
  const last = new Date(`${period.end}T00:00:00.000Z`);
  while (date <= last) {
    seen.add(date.toISOString().slice(0, 7));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return [...seen];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/slackMirror.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the git-ignore entry**

Append to `.gitignore`:

```
# slack raw mirror (re-syncable from Slack; PII + volume)
data/slack/
```

- [ ] **Step 6: Verify lint + types**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add lib/slackMirror.ts lib/slackMirror.test.ts .gitignore
git commit -m "feat(slack-mirror): mirror types + path/period helpers + gitignore"
```

---

### Task 2: Pure merge core — `upsertMessages` + `mergeMessages`

**Files:**
- Modify: `lib/slackMirror.ts`
- Test: `lib/slackMirror.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `lib/slackMirror.test.ts` (add the imports `mergeMessages`, `upsertMessages`, and `type StoredMessage` to the existing import from `./slackMirror`):

```ts
import {
  mergeMessages,
  monthFilePath,
  monthsInPeriod,
  syncFilePath,
  upsertMessages,
  type StoredMessage,
} from "./slackMirror";

// Build a StoredMessage with sensible defaults for the field under test.
const stored = (over: Partial<StoredMessage>): StoredMessage => ({
  ts: "1716200000.000200",
  channel: "field-qa",
  authorId: "U1",
  author: "Pilot",
  isoTime: "2026-06-10T09:00:00.000Z",
  text: "hello",
  permalink: "https://x.slack.com/p1",
  firstSeen: "2026-06-10T09:05:00.000Z",
  lastSeen: "2026-06-10T09:05:00.000Z",
  ...over,
});

describe("upsertMessages", () => {
  it("inserts a new message with its firstSeen/lastSeen", () => {
    const now = "2026-06-11T00:00:00.000Z";
    const fresh = stored({ ts: "1.1", firstSeen: now, lastSeen: now });
    const result = upsertMessages({}, [fresh], now);
    expect(result["1.1"].firstSeen).toBe(now);
    expect(result["1.1"].lastSeen).toBe(now);
    expect(result["1.1"].text).toBe("hello");
  });

  it("preserves firstSeen but refreshes text/edited/lastSeen on re-fetch", () => {
    const existing = {
      "1.1": stored({ ts: "1.1", text: "old", firstSeen: "2026-06-10T09:05:00.000Z" }),
    };
    const now = "2026-06-12T00:00:00.000Z";
    const edited = stored({ ts: "1.1", text: "new", edited: "1716300000.000000", firstSeen: now, lastSeen: now });
    const result = upsertMessages(existing, [edited], now);
    expect(result["1.1"].text).toBe("new");
    expect(result["1.1"].edited).toBe("1716300000.000000");
    expect(result["1.1"].firstSeen).toBe("2026-06-10T09:05:00.000Z"); // preserved
    expect(result["1.1"].lastSeen).toBe(now);
  });

  it("clears a stale deleted flag when a tombstoned message reappears", () => {
    const existing = { "1.1": stored({ ts: "1.1", deleted: true }) };
    const now = "2026-06-12T00:00:00.000Z";
    const result = upsertMessages(existing, [stored({ ts: "1.1", firstSeen: now, lastSeen: now })], now);
    expect(result["1.1"].deleted).toBeUndefined();
  });
});

describe("mergeMessages (upsert + tombstone)", () => {
  const windowStart = "2026-06-08T00:00:00.000Z";
  const now = "2026-06-12T00:00:00.000Z";

  it("tombstones a stored message inside the window that is absent from the fetch", () => {
    const existing = { "1.1": stored({ ts: "1.1", isoTime: "2026-06-10T09:00:00.000Z" }) };
    const result = mergeMessages(existing, [], windowStart, now);
    expect(result["1.1"].deleted).toBe(true);
  });

  it("never tombstones a stored message OUTSIDE the window", () => {
    const existing = { "1.1": stored({ ts: "1.1", isoTime: "2026-05-01T09:00:00.000Z" }) };
    const result = mergeMessages(existing, [], windowStart, now);
    expect(result["1.1"].deleted).toBeUndefined();
  });

  it("keeps a still-present message un-tombstoned and upserts replies independently", () => {
    const parent = stored({ ts: "1.1", isoTime: "2026-06-10T09:00:00.000Z", thread_ts: "1.1", reply_count: 1, firstSeen: now, lastSeen: now });
    const reply = stored({ ts: "1.2", isoTime: "2026-06-10T10:00:00.000Z", thread_ts: "1.1", firstSeen: now, lastSeen: now });
    const result = mergeMessages({}, [parent, reply], windowStart, now);
    expect(result["1.1"].deleted).toBeUndefined();
    expect(result["1.2"].thread_ts).toBe("1.1");
    expect(Object.keys(result)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/slackMirror.test.ts`
Expected: FAIL — `upsertMessages`/`mergeMessages` not exported.

- [ ] **Step 3: Implement the pure core in `lib/slackMirror.ts`**

Add (after `monthsInPeriod`):

```ts
/**
 * Upsert fetched messages into the existing map by ts. New records keep their
 * firstSeen; re-fetched records preserve the prior firstSeen, refresh the mutable
 * fields, advance lastSeen, and DROP any deleted flag (a reappearance clears a
 * stale tombstone). Pure — `now` is passed in, no clock read.
 */
export function upsertMessages(
  existing: Record<string, StoredMessage>,
  fetched: StoredMessage[],
  now: string,
): Record<string, StoredMessage> {
  const result: Record<string, StoredMessage> = { ...existing };
  for (const f of fetched) {
    const prior = existing[f.ts];
    // Rebuild explicitly (no `deleted`) so a reappearing message clears its tombstone.
    result[f.ts] = {
      ts: f.ts,
      channel: f.channel,
      authorId: f.authorId,
      author: f.author,
      isoTime: f.isoTime,
      text: f.text,
      permalink: f.permalink,
      files: f.files,
      thread_ts: f.thread_ts,
      reply_count: f.reply_count,
      edited: f.edited,
      firstSeen: prior?.firstSeen ?? f.firstSeen,
      lastSeen: now,
    };
  }
  return result;
}

/**
 * Upsert + tombstone. After upserting, any stored ts whose isoTime falls inside
 * [windowStart, now] and is absent from `fetched` is marked deleted:true (we
 * re-fetched that window, so its absence is real). Messages outside the window are
 * never tombstoned — we didn't ask Slack about them. Pure and deterministic.
 */
export function mergeMessages(
  existing: Record<string, StoredMessage>,
  fetched: StoredMessage[],
  windowStart: string,
  now: string,
): Record<string, StoredMessage> {
  const result = upsertMessages(existing, fetched, now);
  const fetchedTs = new Set(fetched.map((m) => m.ts));
  for (const [ts, msg] of Object.entries(existing)) {
    if (fetchedTs.has(ts)) continue;
    if (msg.isoTime >= windowStart && msg.isoTime <= now) {
      result[ts] = { ...msg, deleted: true };
    }
  }
  return result;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/slackMirror.test.ts`
Expected: PASS (all upsert + merge cases).

- [ ] **Step 5: Commit**

```bash
git add lib/slackMirror.ts lib/slackMirror.test.ts
git commit -m "feat(slack-mirror): pure upsert + merge/tombstone core"
```

---

### Task 3: Month-file + sync-cursor I/O (atomic, baseDir-injectable)

**Files:**
- Modify: `lib/slackMirror.ts`
- Test: `lib/slackMirror.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `lib/slackMirror.test.ts` (extend the `./slackMirror` import with `readMonthFile`, `readSyncCursor`, `writeMonthFile`, `writeSyncCursor`, `type MonthFile`):

```ts
describe("month-file + cursor I/O", () => {
  let baseDir: string;
  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "slack-mirror-"));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("writeMonthFile then readMonthFile round-trips (creating dirs)", () => {
    const file: MonthFile = {
      version: 1,
      channel: "field-qa",
      month: "2026-06",
      messages: { "1.1": stored({ ts: "1.1" }) },
    };
    writeMonthFile("field-qa", "2026-06", file, { baseDir });
    expect(readMonthFile("field-qa", "2026-06", { baseDir })).toEqual(file);
  });

  it("readMonthFile returns null for an absent file", () => {
    expect(readMonthFile("field-qa", "1999-01", { baseDir })).toBeNull();
  });

  it("sync cursor round-trips; missing cursor → null", () => {
    expect(readSyncCursor("field-qa", { baseDir })).toBeNull();
    writeSyncCursor("field-qa", "2026-06-12T00:00:00.000Z", { baseDir });
    expect(readSyncCursor("field-qa", { baseDir })).toEqual({
      version: 1,
      lastSync: "2026-06-12T00:00:00.000Z",
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/slackMirror.test.ts`
Expected: FAIL — `writeMonthFile`/`readMonthFile`/cursor fns not exported.

- [ ] **Step 3: Implement the I/O wrappers in `lib/slackMirror.ts`**

Add:

```ts
function readJson<T>(path: string): T | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return JSON.parse(raw) as T;
}

/** Write JSON atomically: temp file in the same dir, then rename. mkdir -p. */
function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

export function readMonthFile(channel: string, month: string, opts?: MirrorOpts): MonthFile | null {
  return readJson<MonthFile>(monthFilePath(channel, month, opts));
}

export function writeMonthFile(channel: string, month: string, file: MonthFile, opts?: MirrorOpts): void {
  writeJsonAtomic(monthFilePath(channel, month, opts), file);
}

export function readSyncCursor(channel: string, opts?: MirrorOpts): SyncCursor | null {
  return readJson<SyncCursor>(syncFilePath(channel, opts));
}

export function writeSyncCursor(channel: string, lastSync: string, opts?: MirrorOpts): void {
  writeJsonAtomic(syncFilePath(channel, opts), { version: 1, lastSync } satisfies SyncCursor);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/slackMirror.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/slackMirror.ts lib/slackMirror.test.ts
git commit -m "feat(slack-mirror): atomic month-file + sync-cursor I/O"
```

---

### Task 4: `readChannelMessages` — the downstream read API

**Files:**
- Modify: `lib/slackMirror.ts`
- Test: `lib/slackMirror.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `lib/slackMirror.test.ts` (extend the `./slackMirror` import with `readChannelMessages`):

```ts
describe("readChannelMessages", () => {
  let baseDir: string;
  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "slack-mirror-"));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("reads across month boundaries, filters by [start,end], sorts by ts", () => {
    writeMonthFile(
      "field-qa",
      "2026-05",
      {
        version: 1,
        channel: "field-qa",
        month: "2026-05",
        messages: {
          "1.0": stored({ ts: "1.0", isoTime: "2026-05-30T09:00:00.000Z" }),
        },
      },
      { baseDir },
    );
    writeMonthFile(
      "field-qa",
      "2026-06",
      {
        version: 1,
        channel: "field-qa",
        month: "2026-06",
        messages: {
          "3.0": stored({ ts: "3.0", isoTime: "2026-06-02T09:00:00.000Z" }),
          "2.0": stored({ ts: "2.0", isoTime: "2026-06-01T09:00:00.000Z" }),
          "9.0": stored({ ts: "9.0", isoTime: "2026-06-25T09:00:00.000Z" }), // outside end
        },
      },
      { baseDir },
    );

    const msgs = readChannelMessages(
      "field-qa",
      { start: "2026-05-31", end: "2026-06-15" },
      { baseDir },
    );
    expect(msgs.map((m) => m.ts)).toEqual(["2.0", "3.0"]); // 1.0 before start, 9.0 after end
  });

  it("returns [] when the channel has no month files", () => {
    expect(readChannelMessages("datasets", { start: "2026-06-01", end: "2026-06-30" }, { baseDir })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/slackMirror.test.ts`
Expected: FAIL — `readChannelMessages` not exported.

- [ ] **Step 3: Implement `readChannelMessages` in `lib/slackMirror.ts`**

Add:

```ts
/**
 * All mirrored messages for a channel within [period.start, period.end]
 * inclusive (by each message's calendar day), sorted by ts ascending. Reads only
 * the month files the period spans. Tombstoned (deleted) records are INCLUDED —
 * consumers filter them where appropriate.
 */
export function readChannelMessages(
  channel: string,
  period: Period,
  opts?: MirrorOpts,
): StoredMessage[] {
  const out: StoredMessage[] = [];
  for (const month of monthsInPeriod(period)) {
    const file = readMonthFile(channel, month, opts);
    if (!file) continue;
    for (const msg of Object.values(file.messages)) {
      const day = msg.isoTime.slice(0, 10);
      if (day >= period.start && day <= period.end) out.push(msg);
    }
  }
  out.sort((a, b) => a.ts.localeCompare(b.ts));
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/slackMirror.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify full suite + types + lint**

Run: `npm test && npx tsc --noEmit && npm run lint`
Expected: all green (the 140 prior tests + the new slackMirror tests).

- [ ] **Step 6: Commit**

```bash
git add lib/slackMirror.ts lib/slackMirror.test.ts
git commit -m "feat(slack-mirror): readChannelMessages period read API"
```

---

### Task 5: `fetchRawMessages` on `lib/slack.ts` (history + threads + edits)

**Files:**
- Modify: `lib/slack.ts`

This task is network-bound, so it follows the repo convention of **no unit test** (like `fetchMessages`/`lib/jira.ts`); it is verified by `tsc`, the existing suite staying green, and the live smoke test in Task 7. The non-negotiable constraint: **`fetchMessages` must stay behavior-identical** — only additive code.

- [ ] **Step 1: Widen the channels import to include the type**

In `lib/slack.ts`, change:

```ts
import { TRACKED_CHANNELS } from "./slackChannels";
```

to:

```ts
import { TRACKED_CHANNELS, type SlackChannel } from "./slackChannels";
```

- [ ] **Step 2: Add 429/Retry-After handling to the shared `call` (non-breaking)**

Replace the existing `call` function body with a retry loop (the non-429, non-error path is byte-identical to before):

```ts
/** GET a Slack Web API method with bearer auth; retries on 429, throws SlackError otherwise. */
async function call<T extends SlackOk>(method: string, params: URLSearchParams): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(`${API}/${method}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token()}` },
      cache: "no-store",
    });
    if (res.status === 429 && attempt < 5) {
      const retryAfter = Number(res.headers.get("retry-after")) || 1;
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      continue;
    }
    if (!res.ok) {
      throw new SlackError(`Slack ${method} returned ${res.status} ${res.statusText}`, res.status);
    }
    const body = (await res.json()) as T;
    if (!body.ok) {
      // 502: the request reached Slack but it rejected it (auth/scope/etc.).
      throw new SlackError(`Slack ${method} error: ${body.error ?? "unknown"}`, 502);
    }
    return body;
  }
}
```

- [ ] **Step 3: Add the raw types + `fetchRawMessages`**

Append to `lib/slack.ts` (after `fetchMessages`, before `downloadFileBase64`):

```ts
/** A mirror-bound message: SlackMessage fields + thread/edit markers from Slack. */
export interface RawSlackMessage {
  channel: string;
  ts: string;
  authorId: string;
  author: string;
  isoTime: string;
  text: string;
  permalink: string;
  files?: SlackFile[];
  thread_ts?: string;
  reply_count?: number;
  edited?: string;
}

interface RawHistoryMessage {
  user?: string;
  bot_id?: string;
  ts: string;
  text?: string;
  files?: RawFile[];
  thread_ts?: string;
  reply_count?: number;
  edited?: { ts?: string };
}

interface RawHistoryResponse extends SlackOk {
  messages: RawHistoryMessage[];
}

/**
 * Fetch raw messages for [period] from the given channels (default: all tracked),
 * INCLUDING thread replies and `edited` markers — the input the local mirror
 * (lib/slackMirror) stores. Pages conversations.history, then for each parent with
 * replies pages conversations.replies. Additive: does not touch fetchMessages.
 */
export async function fetchRawMessages(
  period: Period,
  channels: SlackChannel[] = TRACKED_CHANNELS,
): Promise<RawSlackMessage[]> {
  if (!DATE_RE.test(period.start) || !DATE_RE.test(period.end)) {
    throw new SlackError(`Period bounds must be YYYY-MM-DD: start=${period.start} end=${period.end}`);
  }
  token();
  const users = await userMap();
  const oldest = epoch(period.start);
  const latest = epoch(period.end, true);
  const out: RawSlackMessage[] = [];

  const normalize = (channel: SlackChannel, m: RawHistoryMessage): RawSlackMessage | null => {
    if (!m.user && !m.bot_id) return null;
    return {
      channel: channel.name,
      ts: m.ts,
      authorId: m.user ?? m.bot_id ?? "",
      author: m.user ? (users.get(m.user) ?? m.user) : (m.bot_id ?? "bot"),
      isoTime: new Date(Number(m.ts) * 1000).toISOString(),
      text: m.text ?? "",
      permalink: permalink(channel.id, m.ts),
      files: toSlackFiles(m.files),
      thread_ts: m.thread_ts,
      reply_count: m.reply_count,
      edited: m.edited?.ts,
    };
  };

  for (const channel of channels) {
    const parents: RawHistoryMessage[] = [];
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({
        channel: channel.id,
        oldest,
        latest,
        inclusive: "true",
        limit: "200",
      });
      if (cursor) params.set("cursor", cursor);
      const page = await call<RawHistoryResponse>("conversations.history", params);
      for (const m of page.messages ?? []) {
        const n = normalize(channel, m);
        if (n) out.push(n);
        if ((m.reply_count ?? 0) > 0) parents.push(m);
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);

    // conversations.history returns thread parents only — page each parent's replies.
    for (const parent of parents) {
      let rcursor: string | undefined;
      do {
        const params = new URLSearchParams({ channel: channel.id, ts: parent.ts, limit: "200" });
        if (rcursor) params.set("cursor", rcursor);
        const page = await call<RawHistoryResponse>("conversations.replies", params);
        for (const m of page.messages ?? []) {
          if (m.ts === parent.ts) continue; // replies echoes the parent first — skip it
          const n = normalize(channel, m);
          if (n) out.push(n);
        }
        rcursor = page.response_metadata?.next_cursor || undefined;
      } while (rcursor);
    }
  }

  return out;
}
```

- [ ] **Step 4: Verify types, lint, and that nothing regressed**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: clean; all existing tests still pass (no test imports `fetchRawMessages`, and `fetchMessages` is unchanged).

- [ ] **Step 5: Commit**

```bash
git add lib/slack.ts
git commit -m "feat(slack-mirror): additive fetchRawMessages (threads + edits) + 429 retry"
```

---

### Task 6: Pure CLI shaping — `scripts/slackSyncArgs.ts`

**Files:**
- Create: `scripts/slackSyncArgs.ts`
- Create: `scripts/slackSyncArgs.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `scripts/slackSyncArgs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { firstOfMonth, parseArgs, subtractDaysIso } from "./slackSyncArgs";

describe("parseArgs", () => {
  it("defaults to incremental mode with a 7-day window", () => {
    expect(parseArgs([])).toEqual({ mode: "incremental", window: 7 });
  });

  it("reads the init positional", () => {
    expect(parseArgs(["init"]).mode).toBe("init");
  });

  it("reads --backfill, --since, --window, --channel", () => {
    expect(parseArgs(["--backfill", "--since", "2026-02-01", "--channel", "field-qa"])).toEqual({
      mode: "backfill",
      since: "2026-02-01",
      window: 7,
      channel: "field-qa",
    });
    expect(parseArgs(["--window", "14"]).window).toBe(14);
  });

  it("throws on a malformed --since", () => {
    expect(() => parseArgs(["--since", "2026/02/01"])).toThrow(/--since/);
  });

  it("throws on a negative or non-numeric --window", () => {
    expect(() => parseArgs(["--window", "-1"])).toThrow(/--window/);
    expect(() => parseArgs(["--window", "abc"])).toThrow(/--window/);
  });
});

describe("firstOfMonth", () => {
  it("returns the first day of today's calendar month", () => {
    expect(firstOfMonth("2026-06-19")).toBe("2026-06-01");
  });
});

describe("subtractDaysIso", () => {
  it("subtracts whole days, crossing a month boundary", () => {
    expect(subtractDaysIso("2026-06-03T00:00:00.000Z", 7)).toBe("2026-05-27T00:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/slackSyncArgs.test.ts`
Expected: FAIL — `Failed to resolve import "./slackSyncArgs"`.

- [ ] **Step 3: Implement `scripts/slackSyncArgs.ts`**

```ts
/**
 * Pure CLI shaping for scripts/slack-sync.ts: arg parsing + window/floor math.
 * No server/Next/fs imports — unit-tested, mirrors scripts/policyReport.ts.
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type SyncMode = "init" | "incremental" | "backfill";

export interface SyncArgs {
  mode: SyncMode;
  /** Backfill floor (YYYY-MM-DD); defaults to the first of the current month. */
  since?: string;
  /** Trailing re-fetch window in days for incremental mode. */
  window: number;
  /** Restrict the run to a single tracked channel name. */
  channel?: string;
}

/** Parse the supported args. `init` is a positional; the rest are flags. */
export function parseArgs(argv: string[]): SyncArgs {
  const args: SyncArgs = { mode: "incremental", window: 7 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "init") {
      args.mode = "init";
    } else if (flag === "--backfill") {
      args.mode = "backfill";
    } else if (flag === "--since") {
      args.since = value;
      i += 1;
    } else if (flag === "--window") {
      args.window = Number(value);
      i += 1;
    } else if (flag === "--channel") {
      args.channel = value;
      i += 1;
    }
  }
  if (args.since !== undefined && !DATE_RE.test(args.since)) {
    throw new Error(`--since must be YYYY-MM-DD: ${args.since}`);
  }
  if (!Number.isFinite(args.window) || args.window < 0) {
    throw new Error(`--window must be a non-negative number: ${args.window}`);
  }
  return args;
}

/** First day (YYYY-MM-DD) of the calendar month containing `today`. */
export function firstOfMonth(today: string): string {
  return `${today.slice(0, 7)}-01`;
}

/** ISO timestamp `days` whole days before `iso`. */
export function subtractDaysIso(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() - days * 86_400_000).toISOString();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/slackSyncArgs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/slackSyncArgs.ts scripts/slackSyncArgs.test.ts
git commit -m "feat(slack-mirror): pure slack-sync arg + window helpers"
```

---

### Task 7: `scripts/slack-sync.ts` CLI + `package.json` entry

**Files:**
- Create: `scripts/slack-sync.ts`
- Modify: `package.json`

Orchestration + I/O shell — not unit-tested (convention); verified by a live smoke run.

- [ ] **Step 1: Add the npm script**

In `package.json`, add to `"scripts"` (after the `"policy"` line):

```json
    "slack-sync": "node --conditions=react-server --import tsx scripts/slack-sync.ts"
```

(Remember to add the trailing comma to the previous `"policy"` line.)

- [ ] **Step 2: Implement `scripts/slack-sync.ts`**

```ts
/**
 * CLI: sync the tracked Slack channels into the local mirror (data/slack/).
 *
 * Usage:
 *   npm run slack-sync -- init                 # first run / reset: backfill from start of current month
 *   npm run slack-sync                         # incremental (auto-inits a channel with no cursor)
 *   npm run slack-sync -- --window 14          # widen the trailing re-fetch window
 *   npm run slack-sync -- --backfill --since 2026-02-01   # reach further back into history
 *   npm run slack-sync -- --channel field-qa   # restrict to one channel (combinable)
 *
 * init/backfill are additive (no tombstoning); incremental re-fetches
 * [lastSync − window, now] and tombstones messages that vanished from that window.
 * Each channel is synced independently — one failure does not abort the others;
 * a channel's cursor advances only on its own success. Exits non-zero if any
 * channel failed.
 *
 * Runs only under Node with `--conditions=react-server` (see package.json) so the
 * `server-only` import in ../lib/slack resolves to its empty module.
 */
import { fetchRawMessages, type RawSlackMessage } from "../lib/slack";
import { FIELD_TIMEZONE } from "../lib/reconcile";
import { TRACKED_CHANNELS, type SlackChannel } from "../lib/slackChannels";
import {
  mergeMessages,
  monthsInPeriod,
  readMonthFile,
  readSyncCursor,
  upsertMessages,
  writeMonthFile,
  writeSyncCursor,
  type MonthFile,
  type StoredMessage,
} from "../lib/slackMirror";
import { firstOfMonth, parseArgs, subtractDaysIso, type SyncArgs } from "./slackSyncArgs";

/** Today's date (YYYY-MM-DD) in the field timezone — the "now" calendar day. */
function todayInFieldTz(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FIELD_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

interface ChannelSummary {
  channel: string;
  fetched: number;
  created: number;
  updated: number;
  tombstoned: number;
}

async function syncChannel(
  channel: SlackChannel,
  args: SyncArgs,
  today: string,
  now: string,
): Promise<ChannelSummary> {
  const cursor = readSyncCursor(channel.name);
  const autoInit = args.mode === "incremental" && !cursor;
  const isInit = args.mode === "init" || autoInit;

  let windowStartIso: string;
  let tombstone: boolean;
  if (isInit) {
    if (autoInit) {
      process.stderr.write(`slack-sync: ${channel.name} — no cursor, initializing from ${firstOfMonth(today)}\n`);
    } else if (cursor) {
      process.stderr.write(`slack-sync: ${channel.name} — re-initializing (use plain slack-sync for incremental)\n`);
    }
    windowStartIso = `${firstOfMonth(today)}T00:00:00.000Z`;
    tombstone = false;
  } else if (args.mode === "backfill") {
    windowStartIso = `${args.since ?? firstOfMonth(today)}T00:00:00.000Z`;
    tombstone = false;
  } else {
    // incremental with an existing cursor
    windowStartIso = subtractDaysIso(cursor!.lastSync, args.window);
    tombstone = true;
  }

  const startDate = windowStartIso.slice(0, 10);
  const raw = await fetchRawMessages({ start: startDate, end: today }, [channel]);
  const fetched: StoredMessage[] = raw.map((r: RawSlackMessage) => ({
    ...r,
    firstSeen: now,
    lastSeen: now,
  }));

  // Group fetched messages by the month of their own day.
  const byMonth = new Map<string, StoredMessage[]>();
  for (const m of fetched) {
    const month = m.isoTime.slice(0, 7);
    const list = byMonth.get(month);
    if (list) list.push(m);
    else byMonth.set(month, [m]);
  }

  // Process every month with fetched messages; for incremental also every month
  // the re-fetch window spans (so tombstoning can see months with no new messages).
  const months = new Set<string>(byMonth.keys());
  if (tombstone) {
    for (const month of monthsInPeriod({ start: startDate, end: today })) months.add(month);
  }

  let created = 0;
  let updated = 0;
  let tombstoned = 0;
  for (const month of months) {
    const existing = readMonthFile(channel.name, month)?.messages ?? {};
    const forMonth = byMonth.get(month) ?? [];
    for (const m of forMonth) {
      if (existing[m.ts]) updated += 1;
      else created += 1;
    }
    const messages = tombstone
      ? mergeMessages(existing, forMonth, windowStartIso, now)
      : upsertMessages(existing, forMonth, now);
    if (tombstone) {
      for (const [ts, m] of Object.entries(messages)) {
        if (m.deleted && !existing[ts]?.deleted) tombstoned += 1;
      }
    }
    const file: MonthFile = { version: 1, channel: channel.name, month, messages };
    writeMonthFile(channel.name, month, file);
  }

  writeSyncCursor(channel.name, now);
  return { channel: channel.name, fetched: fetched.length, created, updated, tombstoned };
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file — rely on the ambient environment.
  }

  const args = parseArgs(process.argv.slice(2));
  const channels = args.channel
    ? TRACKED_CHANNELS.filter((c) => c.name === args.channel)
    : TRACKED_CHANNELS;
  if (channels.length === 0) {
    throw new Error(`Unknown channel: ${args.channel} (tracked: ${TRACKED_CHANNELS.map((c) => c.name).join(", ")})`);
  }

  const today = todayInFieldTz();
  const now = new Date().toISOString();
  let failures = 0;

  for (const channel of channels) {
    try {
      const s = await syncChannel(channel, args, today, now);
      process.stderr.write(
        `slack-sync: ${s.channel} — fetched ${s.fetched}, +${s.created} new, ~${s.updated} updated, †${s.tombstoned} tombstoned\n`,
      );
    } catch (error) {
      failures += 1;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`slack-sync: ${channel.name} FAILED — ${message}\n`);
    }
  }

  if (failures > 0) process.exit(1);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`slack-sync: ${message}\n`);
  process.exit(1);
});
```

- [ ] **Step 3: Verify types + lint + full suite**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: clean; all tests green.

- [ ] **Step 4: Live smoke test — init**

Run: `npm run slack-sync -- init --channel field-qa`
Expected (stderr): a line like `slack-sync: field-qa — fetched <N>, +<N> new, ~0 updated, †0 tombstoned`, and on disk:
- `data/slack/field-qa/2026-06.json` exists with a `messages` object keyed by ts.
- `data/slack/field-qa/_sync.json` exists with `{ "version": 1, "lastSync": "<ISO>" }`.

Verify it is git-ignored:

Run: `git status --porcelain data/`
Expected: no output (the `data/slack/` entry from Task 1 ignores it).

- [ ] **Step 5: Live smoke test — incremental idempotency**

Run: `npm run slack-sync -- --channel field-qa`
Expected: a second run reports mostly `~updated` (re-seen) and `+0`/low `new`; re-running does not duplicate keys (open `data/slack/field-qa/2026-06.json` and confirm the same ts keys, with advanced `lastSeen`). `firstSeen` on a previously-stored message is unchanged.

- [ ] **Step 6: Commit**

```bash
git add scripts/slack-sync.ts package.json
git commit -m "feat(slack-mirror): slack-sync CLI (init/incremental/backfill)"
```

---

## Final verification (after all tasks)

- [ ] `npm test` — all green (140 prior + new `slackMirror` + `slackSyncArgs` suites).
- [ ] `npm run lint` — clean.
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npm run build` — succeeds (confirms no `"use client"` file pulled in `node:fs`/`lib/slackMirror`, and `lib/slack.ts` stayed server-only-safe).
- [ ] `git status --porcelain data/` — empty (raw mirror git-ignored).
- [ ] `npm run slack-sync -- init` then `npm run slack-sync` over all channels — both succeed, exit 0.

## Notes for the implementer

- **Server-only discipline:** never import `lib/slack.ts` from a `"use client"` file. `lib/slackMirror.ts` is deliberately NOT `server-only` (it's fs-only, secret-free) — keep it that way so future server components and the CLI both consume it.
- **Relative imports in scripts and tests** (`../lib/...`, `./slackMirror`) — there is no vitest path alias.
- **`fetchMessages` is sacred:** Task 5 is purely additive. If any existing test or the policy CLI changes behavior, you've regressed — revert and re-do additively.
- **Out of scope (do NOT build):** no web route/page, no file byte downloads, no refactor of existing `fetchMessages` callers to read the mirror, no DERIVE/VERDICT/PUBLISH. Those are S2+.
