/**
 * DB layer for the outbound-message record. NOT server-only (the CLIs import it,
 * same precedent as lib/published.ts). Holds the reserve-then-send writes and the
 * read paths the CLI + web render. Pure decision logic lives in ./outboundKeys.
 */
import { desc, eq, sql } from "drizzle-orm";
import { db, schema } from "./db";
import { decideReserve, detectOrigin, type OutboundStatus } from "./outboundKeys";
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
    // Reclaiming a FAILED row: refresh the payload columns too — the retry may
    // carry different text (e.g. the agent's error fallback replacing a toolong
    // answer), and the row must record what was ACTUALLY sent, not the first
    // attempt's payload (mislead a 2026-08-01 debug session: the audit showed
    // a "sent" answer while Slack displayed the fallback).
    await db
      .update(schema.outboundMessages)
      .set({
        status: "pending",
        attempts: (existing.attempts ?? 1) + 1,
        error: null,
        text: args.text,
        threadTs: args.threadTs,
        reservedAt: args.reservedAt,
      })
      .where(eq(schema.outboundMessages.key, args.key));
  }

  return decision;
}

/**
 * Every outbound row sharing this Slack ts — the original "post" plus any later
 * "edit"/claim rows (each records its own row, same ts, its own key). The sprint
 * fill-in's safety guard (lib/proposalExecutor `sprint_plan_build`) inspects the
 * full set: a `sprint-plan-pending:` row proves the target is OUR fallback
 * anchor, and a `sprint-plan-filled:` row reveals a fill that already happened
 * (its slug decides retry-vs-refuse).
 */
export async function findSentByTs(ts: string): Promise<OutboundRow[]> {
  return db.select().from(schema.outboundMessages).where(eq(schema.outboundMessages.ts, ts));
}

/** The SENT row under `key` (with a ts), or null. Used by the cross-link
 *  planner to find the drone reminder / Звіт-thread reply it posted earlier. */
export async function findSentByKey(key: string): Promise<OutboundRow | null> {
  const [row] = await db.select().from(schema.outboundMessages).where(eq(schema.outboundMessages.key, key)).limit(1);
  return row && row.status === "sent" && row.ts ? row : null;
}

/** Every row of one feature (indexed). Small tables (reminders, summaries). */
export async function readOutboundByFeature(feature: string): Promise<OutboundRow[]> {
  return db.select().from(schema.outboundMessages).where(eq(schema.outboundMessages.feature, feature));
}

/**
 * Reserve `key` as already SATISFIED by an existing message — no send happens.
 * The sprint fill-in EDITS the pending fallback anchor into the real Committed
 * post, so the committed anchor's key (`sprintAnchorKey`) is never reserved by
 * an actual send; without this claim the next cron re-fire (same sprint still
 * active) would win that reservation and post a DUPLICATE anchor whose thread
 * replies all dedup-skip into the original thread — an orphan anchor with
 * nothing under it. ON CONFLICT DO NOTHING keeps it idempotent and means a real
 * send's row is never clobbered. Returns whether THIS call claimed the key.
 */
export async function claimSentKey(
  key: string,
  ts: string,
  meta: { feature: string; kind: string; channel: string; channelId: string; text: string; trigger: string },
): Promise<boolean> {
  const now = new Date().toISOString();
  const inserted = await db
    .insert(schema.outboundMessages)
    .values({
      key,
      feature: meta.feature,
      kind: meta.kind,
      channel: meta.channel,
      channelId: meta.channelId,
      text: meta.text,
      threadTs: null,
      ts,
      status: "sent",
      origin: detectOrigin(),
      trigger: meta.trigger,
      error: null,
      // No send was attempted under THIS key — it points at a message that
      // already exists (sent under a different key).
      attempts: 0,
      reservedAt: now,
      sentAt: now,
    })
    .onConflictDoNothing()
    .returning({ key: schema.outboundMessages.key });
  return inserted.length > 0;
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

/**
 * Rows whose send was attempted within [period.start, period.end], newest first.
 * Buckets by COALESCE(sentAt, reservedAt) so failed/pending rows (sentAt still
 * null) stay visible — surfacing failures is the audit log's main purpose.
 * NOTE: bounds are compared as UTC ISO strings, not Europe/Kyiv — month-edge
 * sends can bucket a few hours off; acceptable for an internal audit log.
 */
export async function readOutbound(period: Period): Promise<OutboundRow[]> {
  const startIso = `${period.start}T00:00:00.000Z`;
  const endIso = `${period.end}T23:59:59.999Z`;
  const when = sql`coalesce(${schema.outboundMessages.sentAt}, ${schema.outboundMessages.reservedAt})`;
  return db
    .select()
    .from(schema.outboundMessages)
    .where(sql`${when} >= ${startIso} and ${when} <= ${endIso}`)
    .orderBy(desc(when));
}

/** Distinct YYYY-MM (UTC) months that have any row, newest first. */
export async function readOutboundPeriods(): Promise<string[]> {
  const rows = await db
    .select({
      sentAt: schema.outboundMessages.sentAt,
      reservedAt: schema.outboundMessages.reservedAt,
    })
    .from(schema.outboundMessages);
  const months = new Set<string>();
  for (const r of rows) months.add((r.sentAt ?? r.reservedAt).slice(0, 7));
  return [...months].sort().reverse();
}
