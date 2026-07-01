/**
 * Slack event-id idempotency claim. Atomic reserve mirroring lib/outbound.ts's
 * reserveSend: INSERT ... ON CONFLICT DO NOTHING RETURNING makes "have we seen
 * this event_id?" a single atomic step safe across concurrent deliveries. Returns
 * true when our insert landed (first time — process the event), false when the
 * row already existed (a redelivery — skip). NOT server-only (the events route is
 * server-side, but this follows the lib/outbound.ts precedent).
 */
import { db, schema } from "./db";

export async function claimSlackEvent(
  eventId: string,
  seenAt: string,
  meta?: { eventType?: string; outcome?: string },
): Promise<boolean> {
  const inserted = await db
    .insert(schema.slackEventsSeen)
    .values({
      eventId,
      seenAt,
      eventType: meta?.eventType ?? null,
      outcome: meta?.outcome ?? null,
    })
    .onConflictDoNothing()
    .returning();
  return inserted.length > 0;
}
