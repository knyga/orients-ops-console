/**
 * DB layer for the outbound-message record. NOT server-only (the CLIs import it,
 * same precedent as lib/published.ts). Holds the reserve-then-send writes and the
 * read paths the CLI + web render. Pure decision logic lives in ./outboundKeys.
 */
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db, schema } from "./db";
import { decideReserve, type OutboundStatus } from "./outboundKeys";
import type { Period } from "./period";

export type OutboundRow = typeof schema.outboundMessages.$inferSelect;

export interface ReserveArgs {
  key: string;
  feature: string;
  kind: string;
  channel: string;
  channelId: string;
  text: string;
  threadTs: string | null;
  ts: string | null;
  origin: string;
  trigger: string;
  reservedAt: string;
}

/**
 * Reserve the key by inserting a `pending` row. ON CONFLICT DO NOTHING makes the
 * insert atomic across execution points. If we lose, a prior FAILED row is
 * reclaimed for retry (set back to pending); a sent/pending row means skip.
 */
export async function reserveSend(
  args: ReserveArgs,
): Promise<{ won: boolean; existingTs: string | null }> {
  const inserted = await db
    .insert(schema.outboundMessages)
    .values({
      key: args.key,
      feature: args.feature,
      kind: args.kind,
      channel: args.channel,
      channelId: args.channelId,
      text: args.text,
      threadTs: args.threadTs,
      ts: args.ts,
      status: "pending",
      origin: args.origin,
      trigger: args.trigger,
      error: null,
      attempts: 1,
      reservedAt: args.reservedAt,
      sentAt: null,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted.length > 0) {
    return decideReserve({ ts: inserted[0].ts ?? null }, null);
  }

  const [existing] = await db
    .select()
    .from(schema.outboundMessages)
    .where(eq(schema.outboundMessages.key, args.key))
    .limit(1);

  const decision = decideReserve(
    null,
    existing ? { status: existing.status as OutboundStatus, ts: existing.ts ?? null } : null,
  );

  if (decision.won && existing) {
    await db
      .update(schema.outboundMessages)
      .set({
        status: "pending",
        attempts: (existing.attempts ?? 1) + 1,
        error: null,
        reservedAt: args.reservedAt,
      })
      .where(eq(schema.outboundMessages.key, args.key));
  }

  return decision;
}

export async function markSent(key: string, ts: string, sentAt: string): Promise<void> {
  await db
    .update(schema.outboundMessages)
    .set({ status: "sent", ts, sentAt })
    .where(eq(schema.outboundMessages.key, key));
}

export async function markFailed(key: string, error: string): Promise<void> {
  await db
    .update(schema.outboundMessages)
    .set({ status: "failed", error })
    .where(eq(schema.outboundMessages.key, key));
}

/** Rows sent within [period.start, period.end] (UTC), newest first. */
export async function readOutbound(period: Period): Promise<OutboundRow[]> {
  const startIso = `${period.start}T00:00:00.000Z`;
  const endIso = `${period.end}T23:59:59.999Z`;
  return db
    .select()
    .from(schema.outboundMessages)
    .where(
      and(
        gte(schema.outboundMessages.sentAt, startIso),
        lte(schema.outboundMessages.sentAt, endIso),
      ),
    )
    .orderBy(desc(schema.outboundMessages.sentAt));
}

/** Distinct YYYY-MM (UTC) months that have sent rows, newest first. */
export async function readOutboundPeriods(): Promise<string[]> {
  const rows = await db
    .select({ sentAt: schema.outboundMessages.sentAt })
    .from(schema.outboundMessages);
  const months = new Set<string>();
  for (const r of rows) if (r.sentAt) months.add(r.sentAt.slice(0, 7));
  return [...months].sort().reverse();
}
