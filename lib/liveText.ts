/**
 * The text a verdict message currently shows in Slack. NOT server-only (imports
 * only ./outbound + ./dayLinks's pure `latestTextForTs`, same precedent as
 * lib/published.ts / lib/outbound.ts).
 *
 * Every edit of a bot message goes through lib/slack.ts `updateMessage` →
 * `sendTracked` → an `outbound_messages` row (`kind: "edit"`, the target's ts,
 * the exact text sent, `status: "sent"`). So the live Slack text of a verdict
 * is the text of the newest SENT row sharing its ts — the original post
 * (`feature: "verdict"`) or any later edit (approval override, roster
 * correction, cross-link, backfill) — never necessarily `published.text`,
 * which an approver-overridden verdict deliberately leaves at its FIRST-posted
 * (pre-strike) render (see lib/applyApproval.ts `amendPublishedVerdict`).
 */
import { findSentByTs } from "./outbound";
import { latestTextForTs } from "./dayLinks";
import type { PublishedEntry } from "./published";

export async function liveVerdictText(entry: PublishedEntry): Promise<string> {
  const rows = await findSentByTs(entry.ts);
  const text = latestTextForTs(
    rows.map((r) => ({
      key: r.key,
      feature: r.feature,
      status: r.status,
      ts: r.ts,
      text: r.text,
      channel: r.channel,
      sentAt: r.sentAt,
    })),
    entry.ts,
  );
  return text ?? entry.text;
}
