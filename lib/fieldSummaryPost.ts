/**
 * Server-side assembly + posting of the per-day field summary (the pure
 * renderer is lib/fieldMonthSummary.ts). Shared by the CLI
 * (`npm run field-summary`) and the agent's confirm-first `field_summary_post`
 * tool via lib/proposalExecutor, so both surfaces post byte-identical text.
 *
 * Inputs are the COMMITTED reports (field-verdict — refreshed nightly, and the
 * single source for status, crew, window and the per-person drone-gate names
 * (`droneMissingSubmitters`, computed with the SAME predicate + approver
 * eligibility the pay gate uses — never re-derived here); field-qa — its
 * per-person drone counts; field-bonus — OPTIONAL, only to list accepted-day
 * crew the pay roster left out for a non-gate reason as «не зараховано до
 * бонусу») plus the published log for verdict links.
 * SERVER-ONLY reachable (DB + Slack).
 */
import "server-only";
import { readReportJson, periodKey } from "./reports";
import { readPublished } from "./published";
import { reportKey, type DayVerdict } from "./fieldDayVerdict";
import { EARLY_CUTOFF_MIN, type DayBonus } from "./fieldBonus";
import { TRACKED_CHANNELS } from "./slackChannels";
import { permalinkFor, postMessage } from "./slack";
import { fieldSummaryKey, type SendTrigger } from "./outboundKeys";
import { buildMonthSummary, type SummaryDay, type SummaryStatus } from "./fieldMonthSummary";
export { parseSummaryPeriod, summaryCounts, countsUk, type SummaryCounts } from "./fieldMonthSummary";
import type { Period } from "./period";

interface FieldQaDay {
  date: string;
  droneReport?: { name: string; isPerson: boolean; count: number }[];
}

function approverFromReasons(reasons: string[]): string | null {
  for (const r of reasons) {
    const m = /^(?:exception|rejected) \(([^)]+)\):/.exec(r);
    if (m) return m[1];
  }
  return null;
}

function isWeekend(date: string): boolean {
  const d = new Date(`${date}T12:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
}

function startMinutes(window: { start: string } | null | undefined): number | null {
  if (!window) return null;
  const [h, m] = window.start.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

/** The period's SummaryDay rows from the committed reports (throws when the verdict is missing). */
export async function assembleSummaryDays(period: Period): Promise<SummaryDay[]> {
  const key = periodKey(period);
  const verdict = await readReportJson<{ days: DayVerdict[] }>("field-verdict", key);
  if (!verdict) {
    throw new Error(`немає збереженого field-verdict за ${key} — запустіть \`npm run field-verdict -- --start ${period.start} --end ${period.end} --write\`.`);
  }
  const fieldQa = await readReportJson<{ days: FieldQaDay[] }>("field-qa", key);
  const bonus = await readReportJson<{ days: Pick<DayBonus, "date" | "reportTs" | "roster" | "paidRoster">[] }>("field-bonus", key);
  const fieldQaChannel = TRACKED_CHANNELS.find((c) => c.name === "field-qa");
  if (!fieldQaChannel) throw new Error("#field-qa is not a tracked channel");
  const published = await readPublished(period);
  const qaByDate = new Map((fieldQa?.days ?? []).map((d) => [d.date, d]));
  const bonusByKey = new Map((bonus?.days ?? []).map((d) => [reportKey(d.date, d.reportTs), d]));

  return verdict.days.map((v) => {
    const qa = qaByDate.get(v.date);
    const b = bonusByKey.get(reportKey(v.date, v.reportTs));
    const gateExcluded = v.droneMissingSubmitters ?? [];
    const accepted = v.status === "ACCEPTED" || v.status === "ACCEPTED_EXCEPTION";
    const notCounted =
      accepted && b ? v.roster.filter((n) => !(b.paidRoster ?? v.roster).includes(n) && !gateExcluded.includes(n)) : [];
    const pub = published[reportKey(v.date, v.reportTs)] ?? published[v.date];
    const sm = startMinutes(v.deployWindow);
    return {
      date: v.date,
      reportSeq: v.reportSeq,
      reportCount: v.reportCount,
      roster: v.roster,
      deployWindow: v.deployWindow ?? null,
      deployMin: v.deployMin ?? null,
      airborneMinutes: v.airborneMinutes,
      airborneReported: v.airborneReported !== false,
      videoMinutes: v.videoMinutes,
      status: v.status as SummaryStatus,
      early: sm != null && sm <= EARLY_CUTOFF_MIN,
      weekend: isWeekend(v.date),
      droneCounts: (qa?.droneReport ?? []).filter((e) => e.isPerson).map((e) => ({ name: e.name, count: e.count })),
      droneReportKnown: Array.isArray(qa?.droneReport),
      // Verdict-owned: same predicate + approver eligibility as the pay gate; empty when attribution is unknown.
      gateExcluded,
      notCounted,
      approver: approverFromReasons(v.reasons),
      reasons: v.reasons,
      hasZvit: v.hasZvit !== false,
      verdictUrl: pub ? permalinkFor(fieldQaChannel.id, pub.ts) : null,
      zvitUrl: v.reportTs ? permalinkFor(fieldQaChannel.id, v.reportTs) : null,
    };
  });
}

export interface PostFieldSummaryArgs {
  channelId: string;
  period: Period;
  /** Kyiv calendar day the summary is "as of" (also salts the idempotency key). */
  today: string;
  /** When set, everything (anchor text + day lines) goes into this existing thread. */
  threadTs?: string;
  trigger: SendTrigger;
}

/**
 * Post the summary: a short anchor (new top-level post, or a reply when
 * `threadTs` is given) + the per-day lines as replies under it. Idempotent per
 * (period, today, part) through the outbound chokepoint.
 */
export async function postFieldSummary(args: PostFieldSummaryArgs): Promise<{ anchorTs: string; replies: number; days: number }> {
  const channel = TRACKED_CHANNELS.find((c) => c.id === args.channelId);
  if (!channel) throw new Error(`канал ${args.channelId} не відстежується — підсумок можна публікувати лише у відстежуваних каналах.`);
  const days = await assembleSummaryDays(args.period);
  const { anchor, details } = buildMonthSummary(args.period, args.today, days, { inThread: Boolean(args.threadTs) });
  const key = periodKey(args.period);
  const meta = (part: string) => ({
    key: fieldSummaryKey(key, args.today, channel.name, args.threadTs ?? null, part),
    feature: "field-summary",
    channel: channel.name,
    trigger: args.trigger,
  });
  const anchorTs = await postMessage(channel.id, anchor, meta("anchor"), args.threadTs);
  // An empty ts means the chokepoint skipped the send (a stuck `pending`
  // reservation) — posting the day lines now would scatter them top-level.
  if (!anchorTs) throw new Error("анкор підсумку не надіслано (застрягла резервація) — деталі не публікую; повторіть пізніше.");
  // Day lines hang under the anchor (new post) or under the existing thread root.
  const threadRoot = args.threadTs ?? anchorTs;
  for (const [i, d] of details.entries()) {
    await postMessage(channel.id, d, meta(`t${i + 1}`), threadRoot);
  }
  return { anchorTs, replies: details.length, days: days.length };
}
