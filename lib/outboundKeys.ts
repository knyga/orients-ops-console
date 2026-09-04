/**
 * Pure helpers for the outbound-message record: idempotency-key builders, a
 * content hash for keying distinct edits, origin detection, and the
 * reserve-then-send decision. No DB, no Slack, no node:fs — unit-testable.
 */
export type SendTrigger = "cli" | "cron" | "webhook" | "unknown";
export type OutboundStatus = "pending" | "sent" | "failed" | "skipped"; // "skipped" is reserved for forward-compat / manual ops — no code path writes it today

/** Stable, dependency-free djb2 hash → base36. Used to key distinct edits. */
export function contentRev(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

/** Which point of execution this is. Vercel sets VERCEL=1 in its runtime. */
export function detectOrigin(
  env: Record<string, string | undefined> = process.env,
): "vercel" | "local" {
  return env.VERCEL === "1" ? "vercel" : "local";
}

export const verdictKey = (periodKey: string, date: string, reportTs?: string | null): string =>
  reportTs ? `verdict:${periodKey}:${date}:${reportTs}` : `verdict:${periodKey}:${date}`;
export const askKey = (gapType: string, date: string): string => `ask:${gapType}:${date}`;
export const approvalEditKey = (date: string, rev: string): string =>
  `approval-edit:${date}:${rev}`;
export const approvalAckKey = (date: string, rev: string): string =>
  `approval-ack:${date}:${rev}`;
/**
 * Dedup keys for an approver override's verdict edit + threaded ack. Keyed by the
 * DECISION, not the reason text: Claude re-generates the reason (differently) on
 * each Slack event redelivery, so a content hash would let the same reply
 * double-post. Decision-keying makes a redelivered event dedup to one send, while
 * a genuine flip (accept → reject) still changes the key and reposts.
 *
 * `salt` (the instructing reply's Slack ts, or a run-day marker for the CLI)
 * additionally separates a flip BACK to an earlier decision: accept → reject →
 * accept reuses the first accept's decision key, and on 2026-09-04 the second
 * accept was silently skipped as "already sent" — the DB flipped, Slack still
 * showed «відхилено», and the approver got no ack. A redelivery of the same
 * reply carries the same ts, so it still dedups to one send.
 */
export const approvalOutboundKeys = (
  date: string,
  decision: string,
  salt?: string,
): { editKey: string; ackKey: string } => {
  const rev = salt ? `${decision}:${salt}` : decision;
  return { editKey: approvalEditKey(date, rev), ackKey: approvalAckKey(date, rev) };
};
export const webhookFailureKey = (date: string, kind: string, rev: string): string =>
  `webhook-failure:${date}:${kind}:${rev}`;
/**
 * DM help reply, keyed on the triggering message's ts so each distinct DM gets
 * exactly one reply: a Slack redelivery of the same event dedups to one send,
 * while a genuinely new DM (new ts) re-replies.
 */
export const dmHelpKey = (userId: string, ts: string): string => `help:${userId}:${ts}`;
export const agentReplyKey = (userId: string, ts: string): string => `agent:${userId}:${ts}`;
export const bonusThreadKey = (date: string): string => `bonus-thread:${date}`;
export const bonusDmKey = (date: string, slackId: string): string =>
  `bonus-dm:${date}:${slackId}`;
/**
 * One-time backfill edit of a published verdict (rewrite to the current Ukrainian
 * format). Keyed by the new text's `contentRev` so the same edit dedups on re-run
 * but a different target re-edits — and namespaced apart from `verdictKey` so it
 * never collides with the original post's reservation (which would skip the edit).
 */
export const backfillEditKey = (date: string, rev: string): string =>
  `backfill-edit:${date}:${rev}`;

/** Confirm-first instruction: threaded ack for the dataset/video/airborne axes
 *  (crew uses rosterAckKey, day uses approvalAckKey). Keyed by content-rev. */
export const instructionAckKey = (date: string, axis: string, rev: string): string =>
  `instruction-ack:${date}:${axis}:${rev}`;

/**
 * Sprint posts: the ANCHOR channel message and its numbered THREAD replies. Keyed
 * by sprint slug so the weekly cron's ±59-min re-fire dedups to one publication
 * while a new sprint (new slug) reposts, and by CHANNEL so a test-channel dry
 * publish can never hand the #general run a foreign `thread_ts`. The `v2` segment
 * separates this anchor+thread shape from the pre-2026-08-26 single-post keys, so a
 * re-run for a sprint posted in the old format cannot thread new detail replies
 * under that old oversized message.
 */
export const sprintAnchorKey = (
  kind: "committed" | "completed",
  slug: string,
  channel: string,
): string => `sprint-${kind}:v2:${channel}:${slug}`;
/** One detail message under the anchor; `index` is 1-based. Positional keys are
 *  safe because the published texts are frozen in the sprint record and replayed
 *  verbatim on a retry (see lib/sprintPublish.ts). */
export const sprintThreadKey = (
  kind: "committed" | "completed",
  slug: string,
  channel: string,
  index: number,
): string => `${sprintAnchorKey(kind, slug, channel)}:t${index}`;

/**
 * Sprint-plan FALLBACK anchor: posted by the Tuesday commit job when the board
 * has no active sprint (the plan cannot be built yet). Keyed on the run's Kyiv
 * calendar day, so a ±59-min cron re-fire dedups to one post while a genuinely
 * missed following week (new day) posts a fresh anchor. Channel-scoped like
 * `sprintAnchorKey`: a fallback sent to a test channel must never suppress the
 * same day's real #general fallback.
 */
export const sprintPlanPendingKey = (day: string, channel: string): string =>
  `sprint-plan-pending:${channel}:${day}`;
/**
 * The mention-driven fill-in's EDIT of that anchor into the real Committed post.
 * Namespaced apart from `sprintAnchorKey` so the edit never collides with a
 * reservation that would skip it (same reasoning as `backfillEditKey`), and
 * channel-scoped for the same reason as the pending key. The slug is the LAST
 * segment — the fill-in guard (lib/proposalExecutor) parses it back out.
 */
export const sprintPlanFilledKey = (slug: string, channel: string): string =>
  `sprint-plan-filled:${channel}:${slug}`;

/**
 * Ops-failure alert DM to one approver. Keyed per approver + Kyiv day + error
 * class, so a broken integration (e.g. an expired Jira token failing every
 * agent turn) alerts each approver once per day instead of per event, while a
 * different error class the same day still alerts.
 */
export const opsAlertKey = (userId: string, day: string, errKey: string): string =>
  `ops-alert:${userId}:${day}:${errKey}`;

/** Weekly investor report post, keyed by the explicit Mon_Sun week key. */
export const investorKey = (periodKey: string): string => `investor:${periodKey}`;

/**
 * Per-day field summary (lib/fieldSummaryPost): ONE anchor + N thread parts,
 * keyed by period, the Kyiv day it is "as of", the CHANNEL (a same-day test-
 * channel publish must never dedup the #field-qa one — see the sprint keys),
 * the thread it was asked in (a re-ask into a different thread posts anew),
 * and the part ("anchor" | "t1" | "t2" …).
 */
export const fieldSummaryKey = (
  periodKey: string,
  day: string,
  channel: string,
  threadTs: string | null,
  part: string,
): string => `field-summary:${periodKey}:${day}:${channel}${threadTs ? `:${threadTs}` : ""}:${part}`;

/** Roster correction (S-roster): edit the verdict's crew suffix + threaded ack. */
export const rosterEditKey = (date: string, rev: string): string =>
  `roster-edit:${date}:${rev}`;
export const rosterAckKey = (date: string, rev: string): string =>
  `roster-ack:${date}:${rev}`;

/**
 * Decide the reserve outcome. We win (and should send) when our INSERT landed,
 * OR when the only existing row is a prior FAILED attempt (retry). We lose (skip
 * the send) when a sent/pending/skipped row already holds the key.
 *
 * Losing to a PENDING row surfaces NO ts: that send never landed (the row is a
 * stuck reservation from a hard-killed run). This matters for EDITS, whose
 * reservation row carries the known target ts up-front — returning it would let
 * a skipped edit masquerade as a message that carries the content (bit the
 * sprint-plan fill-in, 2026-08-26: a stuck `sprint-plan-filled:` row made the
 * retry look successful while the anchor still showed the fallback text).
 */
export function decideReserve(
  inserted: { ts: string | null } | null,
  existing: { status: OutboundStatus; ts: string | null } | null,
): { won: boolean; existingTs: string | null } {
  if (inserted) return { won: true, existingTs: inserted.ts };
  if (existing && existing.status === "failed") return { won: true, existingTs: existing.ts };
  if (existing && existing.status === "pending") return { won: false, existingTs: null };
  return { won: false, existingTs: existing?.ts ?? null };
}
