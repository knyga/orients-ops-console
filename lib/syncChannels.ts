/**
 * Shared Slack-mirror sync orchestration. SERVER-ONLY (fetches live Slack). One
 * source of truth for the per-channel sync, called by BOTH the `slack-sync` CLI
 * and the nightly pipeline (`lib/runNightly` / `/api/cron/field-nightly`).
 * The pure merge/tombstone core stays in
 * lib/slackMirror; this just drives it per channel. Each channel syncs
 * independently — one failure never aborts the others, and a channel's cursor
 * advances only on its own success.
 */
import "server-only";
import { fetchRawMessages } from "./slack";
import { FIELD_TIMEZONE } from "./reconcile";
import { TRACKED_CHANNELS, type SlackChannel } from "./slackChannels";
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
} from "./slackMirror";
import { firstOfMonth, subtractDaysIso, type SyncMode } from "../scripts/slackSyncArgs";

export interface SyncChannelsOptions {
  mode: SyncMode;
  /** Trailing re-fetch window in days for incremental mode. */
  window: number;
  /** Backfill floor (YYYY-MM-DD); defaults to the first of the current month. */
  since?: string;
  /** Channels to sync (default: all tracked). */
  channels?: SlackChannel[];
  /** Optional progress sink (the CLI passes stderr; the cron route omits it). */
  onLog?: (message: string) => void;
}

export interface ChannelSummary {
  channel: string;
  fetched: number;
  created: number;
  updated: number;
  tombstoned: number;
  /** Set when this channel's sync threw (the others still ran). */
  error?: string;
}

export interface SyncResult {
  summaries: ChannelSummary[];
  failures: number;
}

/** Today's date (YYYY-MM-DD) in the field timezone — the "now" calendar day. */
export function todayInFieldTz(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FIELD_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function syncChannel(
  channel: SlackChannel,
  opts: SyncChannelsOptions,
  today: string,
  now: string,
): Promise<ChannelSummary> {
  const log = opts.onLog ?? (() => {});
  const cursor = await readSyncCursor(channel.name);
  const autoInit = opts.mode === "incremental" && !cursor;
  const isInit = opts.mode === "init" || autoInit;

  let windowStartIso: string;
  let tombstone: boolean;
  if (isInit) {
    if (autoInit) {
      log(`slack-sync: ${channel.name} — no cursor, auto-initializing from ${firstOfMonth(today)}`);
    } else if (!cursor) {
      log(`slack-sync: ${channel.name} — initializing from ${firstOfMonth(today)}`);
    } else {
      log(`slack-sync: ${channel.name} — re-initializing from ${firstOfMonth(today)} (use plain slack-sync for incremental)`);
    }
    windowStartIso = `${firstOfMonth(today)}T00:00:00.000Z`;
    tombstone = false;
  } else if (opts.mode === "backfill") {
    windowStartIso = `${opts.since ?? firstOfMonth(today)}T00:00:00.000Z`;
    tombstone = false;
  } else {
    // incremental with an existing cursor
    windowStartIso = subtractDaysIso(cursor!.lastSync, opts.window);
    tombstone = true;
  }

  const startDate = windowStartIso.slice(0, 10);
  const raw = await fetchRawMessages({ start: startDate, end: today }, [channel]);
  const fetched: StoredMessage[] = raw.map((r) => ({
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
    const existing = (await readMonthFile(channel.name, month))?.messages ?? {};
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
    await writeMonthFile(channel.name, month, file);
  }

  await writeSyncCursor(channel.name, now);
  return { channel: channel.name, fetched: fetched.length, created, updated, tombstoned };
}

/**
 * Sync each requested channel into the local mirror, isolating failures.
 * Computes "today" (field tz) and "now" (ISO) once for the whole run. Returns a
 * per-channel summary plus a failure count (callers exit non-zero on failures).
 */
export async function syncAllChannels(opts: SyncChannelsOptions): Promise<SyncResult> {
  const log = opts.onLog ?? (() => {});
  const channels = opts.channels ?? TRACKED_CHANNELS;
  const today = todayInFieldTz();
  const now = new Date().toISOString();

  // Channels are independent (own files + own cursor, keyed by name — no shared
  // state), so sync them CONCURRENTLY rather than one-at-a-time. The cost is
  // dozens of sequential Slack round-trips per channel (conversations.history +
  // one conversations.replies per thread parent); serialized across ~7 channels
  // that overran the 60s cron cap. Overlapping is safe: call() already backs off
  // on 429. Promise.all preserves input order, and each channel keeps its own
  // try/catch so one failure never aborts the others.
  const summaries: ChannelSummary[] = await Promise.all(
    channels.map(async (channel): Promise<ChannelSummary> => {
      try {
        const s = await syncChannel(channel, opts, today, now);
        log(`slack-sync: ${s.channel} — fetched ${s.fetched}, +${s.created} new, ~${s.updated} updated, †${s.tombstoned} tombstoned`);
        return s;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`slack-sync: ${channel.name} FAILED — ${message}`);
        return { channel: channel.name, fetched: 0, created: 0, updated: 0, tombstoned: 0, error: message };
      }
    }),
  );
  const failures = summaries.filter((s) => s.error).length;
  return { summaries, failures };
}
