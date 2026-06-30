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
import { writePublished, type PublishedEntry } from "./published";
import { upsertRosterCorrection } from "./rosterCorrections";
import { splitRosterSuffix, withRosterSuffix } from "./verdictPublish";
import type { RosterOutcome } from "../scripts/fieldRosterReport";
import type { Period } from "./period";

export async function applyRosterDecision(args: {
  entry: PublishedEntry;
  period: Period;
  outcome: RosterOutcome;
  trigger?: SendTrigger;
}): Promise<{ applied: boolean }> {
  const { entry, period, outcome, trigger = "unknown" } = args;

  await upsertRosterCorrection({
    date: entry.date,
    ...(outcome.roster.length ? { roster: outcome.roster } : {}),
    ...(Object.keys(outcome.eligibility).length ? { eligibility: outcome.eligibility } : {}),
    note: outcome.note,
    by: outcome.by,
    source: outcome.evidencePermalink || "slack",
    recordedAt: new Date().toISOString(),
  });

  const channel = TRACKED_CHANNELS.find((c) => c.name === entry.channel);
  if (!channel) return { applied: false };

  // Edit ONLY the crew suffix; keep the body (incl. any override strike) intact.
  const { body } = splitRosterSuffix(entry.text);
  const updatedText = withRosterSuffix(body, outcome.roster);
  if (updatedText === entry.text) return { applied: false }; // suffix already current

  await updateMessage(channel.id, entry.ts, updatedText, {
    key: rosterEditKey(entry.date, contentRev(updatedText)),
    feature: "roster",
    channel: channel.name,
    trigger,
  });

  const notCounted = Object.entries(outcome.eligibility).filter(([, v]) => v === "not_counted").map(([n]) => n);
  const tail = notCounted.length ? ` (не рахується: ${notCounted.join(", ")})` : "";
  const replyText = `👥 Зафіксовано склад: ${outcome.roster.join(", ")}${tail} — ${outcome.by}.`;
  await postMessage(
    channel.id,
    replyText,
    { key: rosterAckKey(entry.date, contentRev(replyText)), feature: "roster", channel: channel.name, trigger },
    entry.ts,
  );

  await writePublished(period, { [entry.date]: { ...entry, text: updatedText } });
  return { applied: true };
}
