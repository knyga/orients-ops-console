/**
 * Shared effect: apply an approver's roster correction to a published verdict.
 * SERVER-ONLY (writes to Slack + DB). Upserts the correction, edits ONLY the
 * crew suffix of the verdict message (leaving any override amendment in the body
 * intact), and posts a Ukrainian threaded ack. Idempotent via content-rev keys.
 * Mirrors lib/applyApproval.ts. Callable by the field-roster CLI (and later the
 * events webhook).
 */
import "server-only";
import { postMessage, updateMessage } from "./slack";
import { contentRev, rosterAckKey, rosterEditKey, type SendTrigger } from "./outboundKeys";
import { TRACKED_CHANNELS } from "./slackChannels";
import { writePublished, recordPublished, type PublishedEntry } from "./published";
import { upsertRosterCorrection } from "./rosterCorrections";
import { splitRosterSuffix, withRosterSuffix } from "./verdictPublish";
import { reportKey } from "./fieldDayVerdict";
import type { RosterOutcome } from "../scripts/fieldRosterReport";
import type { Period } from "./period";
import { mentionize } from "./mention";

export async function applyRosterDecision(args: {
  entry: PublishedEntry;
  period: Period;
  outcome: RosterOutcome;
  trigger?: SendTrigger;
  /** Per-instruction outbound salt (the instructing reply's ts) — a crew set back
   *  to an earlier roster must re-edit + re-ack instead of deduping against the
   *  first send (see lib/applyInstruction.ts). */
  salt?: string;
}): Promise<{ applied: boolean }> {
  const { entry, period, outcome, trigger = "unknown", salt } = args;

  await upsertRosterCorrection({
    date: entry.date,
    reportTs: entry.reportTs ?? "",
    ...(outcome.roster.length ? { roster: outcome.roster } : {}),
    ...(Object.keys(outcome.eligibility).length ? { eligibility: outcome.eligibility } : {}),
    note: outcome.note,
    by: outcome.by,
    source: outcome.evidencePermalink || "slack",
    recordedAt: new Date().toISOString(),
  });

  const channel = TRACKED_CHANNELS.find((c) => c.name === entry.channel);
  if (!channel) return { applied: false };

  // Edit ONLY the crew suffix; keep the body (incl. any override strike), the
  // trailing drone line AND the 🔗 links line intact — each is a disjoint region.
  const { body, droneLine, linksLine } = splitRosterSuffix(entry.text);
  const withRoster = withRosterSuffix(body, outcome.roster);
  const updatedText = [withRoster, droneLine, linksLine].filter(Boolean).join("\n");
  if (updatedText === entry.text) return { applied: false }; // suffix already current

  const key = reportKey(entry.date, entry.reportTs);
  const rev = (text: string) => (salt ? `${contentRev(text)}:${salt}` : contentRev(text));
  await updateMessage(channel.id, entry.ts, updatedText, {
    key: rosterEditKey(key, rev(updatedText)),
    feature: "roster",
    channel: channel.name,
    trigger,
  });

  const notCounted = Object.entries(outcome.eligibility)
    .filter(([, v]) => v === "not_counted")
    .map(([n]) => mentionize(n));
  const tail = notCounted.length ? ` (не рахується: ${notCounted.join(", ")})` : "";
  const replyText = `👥 Зафіксовано склад: ${outcome.roster.map(mentionize).join(", ")}${tail} — ${mentionize(outcome.by)}.`;
  await postMessage(
    channel.id,
    replyText,
    { key: rosterAckKey(key, rev(replyText)), feature: "roster", channel: channel.name, trigger },
    entry.ts,
  );

  await writePublished(period, recordPublished({}, { ...entry, text: updatedText }));
  return { applied: true };
}
