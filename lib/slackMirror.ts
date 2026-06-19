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
