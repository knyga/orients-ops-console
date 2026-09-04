/**
 * Cross-link (🔗) relink stage — spec
 * docs/superpowers/specs/2026-09-04-field-qa-cross-links-design.md. SERVER-ONLY
 * (edits Slack, rewrites `published.text`). Pure planning lives in
 * lib/dayLinks; this is the effectful driver, called by the nightly, the
 * `field-links` CLI, and the tail of every path that creates a node (bonus
 * notify, summary post, drone reminder).
 *
 * SOFT stage: each edit is independent — a failure is recorded and the loop
 * continues; nothing upstream depends on it and it never DMs the operator.
 * Idempotent: every key is target + contentRev(line) (see lib/outboundKeys).
 * An edit the chokepoint skips (returns "") is counted `skipped`, not sent,
 * and the verdict write-back is withheld, so the next run retries.
 */
import "server-only";
import { permalinkFor, postMessage, updateMessage } from "./slack";
import { TRACKED_CHANNELS } from "./slackChannels";
import { readPublished, findPublishedByTs, writePublished, recordPublished } from "./published";
import { readNotified } from "./bonusNotified";
import { readOutboundByFeature, findSentByKey } from "./outbound";
import { collectDayNodes, planRelink, type DayNodes, type OutboundRowLike, type RelinkEdit } from "./dayLinks";
import { DRONE_REMINDER_FEATURE } from "./droneReminderPlan";
import { LINKS_FEATURE, linksZvitKey, type SendTrigger } from "./outboundKeys";
import { monthsCovering, type Period } from "./period";

const DEFAULT_CHANNEL = "field-qa";

export interface RelinkOptions {
  publish: boolean;
  trigger: SendTrigger;
  /** Post a NEW Звіт-thread reply where missing (edits of an existing one are always allowed). */
  zvitReply: boolean;
  /** Tracked channel NAME the cluster lives in; default #field-qa. */
  channel?: string;
  onLog?: (message: string) => void;
}

export interface RelinkDayResult {
  date: string;
  planned: RelinkEdit[];
  sent: number;
  skipped: number;
  failed: { key: string; error: string }[];
}

export interface RelinkResult {
  channel: string;
  days: RelinkDayResult[];
  sent: number;
  skipped: number;
  failed: number;
}

function inPeriod(date: string, period: Period): boolean {
  return date >= period.start && date <= period.end;
}

/** Read-only: the day clusters + planned edits (shared by dry-run, the web route and the publisher). */
export async function planRelinkForPeriod(
  period: Period,
  dates: string[] | null,
  channelName: string = DEFAULT_CHANNEL,
  zvitReply = true,
): Promise<{ channelId: string; days: { date: string; nodes: DayNodes; edits: RelinkEdit[] }[] }> {
  const channel = TRACKED_CHANNELS.find((c) => c.name === channelName);
  if (!channel) throw new Error(`канал ${channelName} не відстежується — 🔗 редагуємо лише у відстежуваних каналах.`);
  // published/notified are stored per calendar month (periodKey collapses a
  // same-month window, but a cross-month window's range key was never
  // written under); read every month the period touches and merge.
  const months = monthsCovering(period);
  const [publishedLogs, notifiedLogs, reminders, summaries, bonusRows, linksRows] = await Promise.all([
    Promise.all(months.map((m) => readPublished(m))),
    Promise.all(months.map((m) => readNotified(m))),
    readOutboundByFeature(DRONE_REMINDER_FEATURE),
    readOutboundByFeature("field-summary"),
    readOutboundByFeature("bonus"),
    readOutboundByFeature(LINKS_FEATURE),
  ]);
  const published: Awaited<ReturnType<typeof readPublished>> = Object.assign({}, ...publishedLogs);
  const notified: Awaited<ReturnType<typeof readNotified>> = Object.assign({}, ...notifiedLogs);
  const reportTss = Object.values(published).map((e) => e.reportTs).filter((t): t is string => Boolean(t));
  const zvitRows = (await Promise.all(reportTss.map((t) => findSentByKey(linksZvitKey(t))))).filter((r): r is NonNullable<typeof r> => r !== null);
  // `linksRows` (every "links"-feature row: reminder/verdict/bonus/zvit-reply
  // edits + the zvit-reply post) is what makes an edit's CURRENT text visible
  // to collectDayNodes/latestTextForTs — without it the planner only ever saw
  // a target's ORIGINAL post row and would re-plan an edit that had already
  // landed under its own key.
  const outbound: OutboundRowLike[] = [...reminders, ...summaries, ...bonusRows, ...zvitRows, ...linksRows].map((r) => ({
    key: r.key, feature: r.feature, status: r.status, ts: r.ts, text: r.text, channel: r.channel, sentAt: r.sentAt,
  }));

  const candidates = new Set<string>(dates ?? []);
  if (!dates) {
    for (const e of Object.values(published)) if (inPeriod(e.date, period)) candidates.add(e.date);
    for (const r of reminders) {
      const d = r.key.slice(`${DRONE_REMINDER_FEATURE}:`.length);
      if (r.status === "sent" && inPeriod(d, period)) candidates.add(d);
    }
  }
  const permalink = (ts: string) => permalinkFor(channel.id, ts);
  const days = [...candidates].sort().map((date) => {
    const nodes = collectDayNodes({ date, channel: channel.name, published, notified, outbound });
    return { date, nodes, edits: planRelink(nodes, { permalink, zvitReply }) };
  });
  return { channelId: channel.id, days };
}

export async function relinkDays(period: Period, dates: string[] | null, opts: RelinkOptions): Promise<RelinkResult> {
  const log = opts.onLog ?? (() => {});
  const channelName = opts.channel ?? DEFAULT_CHANNEL;
  const { channelId, days } = await planRelinkForPeriod(period, dates, channelName, opts.zvitReply);
  const results: RelinkDayResult[] = [];
  for (const day of days) {
    const res: RelinkDayResult = { date: day.date, planned: day.edits, sent: 0, skipped: 0, failed: [] };
    for (const e of day.edits) {
      if (!opts.publish) { log(`field-links (dry-run): would ${e.op} ${e.key}`); continue; }
      try {
        // Defence in depth: with the planner now reading a target's LATEST
        // text (including its own prior edit rows), this should be a steady-
        // state no-op — but a stale plan (a concurrent run, or a caller that
        // planned once and applies later) can still carry an edit whose key
        // is already SENT. Applying it anyway would have the chokepoint dedup
        // it (returning the prior ts unchanged), which this loop used to
        // miscount as a fresh send.
        const already = await findSentByKey(e.key);
        if (already) { res.skipped += 1; log(`field-links: ${e.key} already sent — skipped`); continue; }
        const meta = { key: e.key, feature: LINKS_FEATURE, channel: channelName, trigger: opts.trigger };
        let ts: string;
        if (e.op === "post") {
          ts = await postMessage(channelId, e.newText, meta, e.threadTs ?? undefined);
        } else {
          if (e.target.kind === "verdict") {
            // TOCTOU guard (same as lib/refreshPublished): an approver strike or a
            // crew edit landing between planning and now must not be clobbered.
            const fresh = await findPublishedByTs(e.ts as string);
            const reportTs = (e.target as { reportTs: string }).reportTs;
            const planned = day.nodes.reports.find((r) => r.reportTs === reportTs);
            if (!fresh || fresh.entry.text !== planned?.verdictText) { res.skipped += 1; log(`field-links: ${e.key} changed-since-plan — skipped`); continue; }
          }
          ts = await updateMessage(channelId, e.ts as string, e.newText, meta);
        }
        if (!ts) { res.skipped += 1; log(`field-links: ${e.key} skipped by the chokepoint (stuck reservation)`); continue; }
        if (e.op === "edit" && e.target.kind === "verdict") {
          const fresh = await findPublishedByTs(e.ts as string);
          if (fresh) await writePublished(fresh.period, recordPublished({}, { ...fresh.entry, text: e.newText }));
        }
        res.sent += 1;
        log(`field-links: ${e.op} ${e.key} → ts ${ts}`);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        res.failed.push({ key: e.key, error });
        log(`field-links: ${e.key} FAILED — ${error}`);
      }
    }
    results.push(res);
  }
  return {
    channel: channelName,
    days: results,
    sent: results.reduce((n, d) => n + d.sent, 0),
    skipped: results.reduce((n, d) => n + d.skipped, 0),
    failed: results.reduce((n, d) => n + d.failed.length, 0),
  };
}
