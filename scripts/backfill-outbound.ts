/**
 * One-time backfill: seed outbound_messages from the already-sent rows in the
 * published + asks tables, so the audit log reflects history sent before this
 * feature existed. Idempotent (ON CONFLICT DO NOTHING) — safe to re-run. Approval
 * edits/acks and webhook failure notices are not reconstructable and are skipped;
 * the log is complete from the first new send onward.
 *
 * Usage: npm run backfill-outbound
 * Runs under `--conditions=react-server` so the import chain resolves.
 */
import { db, schema } from "../lib/db";
import { askKey, verdictKey } from "../lib/outboundKeys";
import { TRACKED_CHANNELS } from "../lib/slackChannels";

function channelId(name: string): string {
  return TRACKED_CHANNELS.find((c) => c.name === name)?.id ?? "";
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    /* rely on ambient env */
  }

  const pub = await db.select().from(schema.published);
  for (const r of pub) {
    await db
      .insert(schema.outboundMessages)
      .values({
        key: verdictKey(r.period, r.date),
        feature: "verdict",
        kind: "post",
        channel: r.channel,
        channelId: channelId(r.channel),
        text: r.text,
        threadTs: null,
        ts: r.ts,
        status: "sent",
        origin: "unknown",
        trigger: "unknown",
        error: null,
        attempts: 1,
        reservedAt: r.postedAt,
        sentAt: r.postedAt,
      })
      .onConflictDoNothing();
  }

  const asks = await db.select().from(schema.asks);
  let asksSeeded = 0;
  for (const a of asks) {
    if (!a.askedTs) continue;
    asksSeeded += 1;
    await db
      .insert(schema.outboundMessages)
      .values({
        key: askKey(a.gapType, a.date),
        feature: "ask",
        kind: "post",
        channel: a.channel,
        channelId: channelId(a.channel),
        text: a.question,
        threadTs: null,
        ts: a.askedTs,
        status: "sent",
        origin: "unknown",
        trigger: "unknown",
        error: null,
        attempts: 1,
        reservedAt: a.askedAt,
        sentAt: a.askedAt,
      })
      .onConflictDoNothing();
  }

  process.stderr.write(
    `backfill-outbound: seeded ${pub.length} verdict(s) and ${asksSeeded} ask(s).\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`backfill-outbound: ${message}\n`);
  process.exit(1);
});
