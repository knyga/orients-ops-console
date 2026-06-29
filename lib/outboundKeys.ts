/**
 * Pure helpers for the outbound-message record: idempotency-key builders, a
 * content hash for keying distinct edits, origin detection, and the
 * reserve-then-send decision. No DB, no Slack, no node:fs — unit-testable.
 */
export type SendTrigger = "cli" | "cron" | "webhook" | "unknown";
export type OutboundStatus = "pending" | "sent" | "failed" | "skipped";

/** Stable, dependency-free djb2 hash → base36. Used to key distinct edits. */
export function contentRev(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

/** Which point of execution this is. Vercel sets VERCEL=1 in its runtime. */
export function detectOrigin(env: NodeJS.ProcessEnv = process.env): "vercel" | "local" {
  return env.VERCEL === "1" ? "vercel" : "local";
}

export const verdictKey = (periodKey: string, date: string): string =>
  `verdict:${periodKey}:${date}`;
export const askKey = (gapType: string, date: string): string => `ask:${gapType}:${date}`;
export const approvalEditKey = (date: string, rev: string): string =>
  `approval-edit:${date}:${rev}`;
export const approvalAckKey = (date: string, rev: string): string =>
  `approval-ack:${date}:${rev}`;
export const webhookFailureKey = (date: string, kind: string, rev: string): string =>
  `webhook-failure:${date}:${kind}:${rev}`;
export const bonusThreadKey = (date: string): string => `bonus-thread:${date}`;
export const bonusDmKey = (date: string, slackId: string): string =>
  `bonus-dm:${date}:${slackId}`;

/**
 * Decide the reserve outcome. We win (and should send) when our INSERT landed,
 * OR when the only existing row is a prior FAILED attempt (retry). We lose (skip
 * the send) when a sent/pending/skipped row already holds the key.
 */
export function decideReserve(
  inserted: { ts: string | null } | null,
  existing: { status: OutboundStatus; ts: string | null } | null,
): { won: boolean; existingTs: string | null } {
  if (inserted) return { won: true, existingTs: inserted.ts };
  if (existing && existing.status === "failed") return { won: true, existingTs: existing.ts };
  return { won: false, existingTs: existing?.ts ?? null };
}
