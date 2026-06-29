/**
 * Reserve-then-send wrapper: the one place every outbound Slack message is
 * recorded + deduped. Deliberately NOT server-only and Slack-agnostic — it takes
 * the raw sender as a callback — so it is unit-testable and the server-only Slack
 * code stays in lib/slack.ts.
 */
import { detectOrigin, type SendTrigger } from "./outboundKeys";
import { markFailed, markSent, reserveSend } from "./outbound";

export interface SendMeta {
  /** Logical-action idempotency key (see lib/outboundKeys.ts builders). */
  key: string;
  feature: string; // "verdict" | "ask" | "approval" | "webhook-failure"
  channel: string; // tracked channel NAME (for the audit row)
  trigger?: SendTrigger;
}

export interface TrackedSendArgs {
  channelId: string;
  text: string;
  kind: "post" | "reply" | "edit";
  threadTs: string | null;
  ts: string | null; // known up-front for edits; null for new posts
  meta: SendMeta;
}

/**
 * Reserve the key, then call `rawSend` only if we own the reservation. `rawSend`
 * returns the posted ts (for edits it returns the edited message's ts). On
 * success the row is marked sent; on failure marked failed and the error rethrows.
 */
export async function sendTracked(
  args: TrackedSendArgs,
  rawSend: () => Promise<string>,
): Promise<string> {
  const reservedAt = new Date().toISOString();
  const { won, existingTs } = await reserveSend({
    key: args.meta.key,
    feature: args.meta.feature,
    kind: args.kind,
    channel: args.meta.channel,
    channelId: args.channelId,
    text: args.text,
    threadTs: args.threadTs,
    ts: args.ts,
    origin: detectOrigin(),
    trigger: args.meta.trigger ?? "unknown",
    reservedAt,
  });

  if (!won) return existingTs ?? args.ts ?? "";

  try {
    const ts = await rawSend();
    const finalTs = ts || args.ts || "";
    await markSent(args.meta.key, finalTs, new Date().toISOString());
    return finalTs;
  } catch (err) {
    await markFailed(args.meta.key, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
