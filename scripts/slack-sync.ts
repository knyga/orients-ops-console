/**
 * CLI: sync the tracked Slack channels into the local mirror (Postgres).
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
 * channel failed. The per-channel sync logic is shared with /api/cron/sync via
 * lib/syncChannels.
 *
 * Runs only under Node with `--conditions=react-server` (see package.json) so the
 * `server-only` import in ../lib/slack resolves to its empty module.
 */
import { TRACKED_CHANNELS } from "../lib/slackChannels";
import { syncAllChannels } from "../lib/syncChannels";
import { parseArgs } from "./slackSyncArgs";

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

  const { failures } = await syncAllChannels({
    mode: args.mode,
    window: args.window,
    since: args.since,
    channels,
    onLog: (message) => process.stderr.write(`${message}\n`),
  });

  if (failures > 0) process.exit(1);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`slack-sync: ${message}\n`);
  process.exit(1);
});
