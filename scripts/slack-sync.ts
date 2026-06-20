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
import { fetchRawMessages } from "../lib/slack";
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
  const cursor = await readSyncCursor(channel.name);
  const autoInit = args.mode === "incremental" && !cursor;
  const isInit = args.mode === "init" || autoInit;

  let windowStartIso: string;
  let tombstone: boolean;
  if (isInit) {
    if (autoInit) {
      process.stderr.write(`slack-sync: ${channel.name} — no cursor, auto-initializing from ${firstOfMonth(today)}\n`);
    } else if (!cursor) {
      process.stderr.write(`slack-sync: ${channel.name} — initializing from ${firstOfMonth(today)}\n`);
    } else {
      process.stderr.write(`slack-sync: ${channel.name} — re-initializing from ${firstOfMonth(today)} (use plain slack-sync for incremental)\n`);
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
