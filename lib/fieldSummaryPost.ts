/**
 * Server-side assembly + posting of the per-day field summary (the pure
 * renderer is lib/fieldMonthSummary.ts). Shared by the CLI
 * (`npm run field-summary`) and the agent's confirm-first `field_summary_post`
 * tool via lib/proposalExecutor, so both surfaces post byte-identical text.
 *
 * Inputs are the COMMITTED reports (field-verdict — refreshed nightly; field-qa
 * — its drone counts/submitters; field-bonus — optional, only for the
 * per-person drone-gate exclusions; when absent the gate is derived from the
 * same `owesDroneSubmission` predicate the pay gate uses, minus approver
 * eligibility overrides) plus the published log for verdict links.
 * SERVER-ONLY reachable (DB + Slack).
 */
import { readReportJson, periodKey } from "./reports";
import { readPublished } from "./published";
import { reportKey, type DayVerdict } from "./fieldDayVerdict";
import type { DayBonus } from "./fieldBonus";
import { EARLY_CUTOFF_MIN } from "./fieldBonus";
import { owesDroneSubmission } from "./droneOwners";
import { TRACKED_CHANNELS } from "./slackChannels";
import { permalinkFor, postMessage } from "./slack";
import type { SendTrigger } from "./outboundKeys";
import { buildMonthSummary, type SummaryDay, type SummaryStatus } from "./fieldMonthSummary";
export { parseSummaryPeriod, summaryCounts, countsUk, type SummaryCounts } from "./fieldMonthSummary";
import type { Period } from "./period";

interface FieldQaDay {
  date: string;
  droneReport?: { name: string; isPerson: boolean; count: number }[];
  droneSubmitters?: string[];
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
  const bonus = await readReportJson<{ days: DayBonus[] }>("field-bonus", key);
  const fieldQa = await readReportJson<{ days: FieldQaDay[] }>("field-qa", key);
  const fieldQaChannel = TRACKED_CHANNELS.find((c) => c.name === "field-qa");
  if (!fieldQaChannel) throw new Error("#field-qa is not a tracked channel");
  const published = await readPublished(period);
  const qaByDate = new Map((fieldQa?.days ?? []).map((d) => [d.date, d]));
  const bonusByKey = new Map((bonus?.days ?? []).map((d) => [reportKey(d.date, d.reportTs), d]));

  return verdict.days.map((v) => {
    const b = bonusByKey.get(reportKey(v.date, v.reportTs));
    const qa = qaByDate.get(v.date);
    const pub = published[reportKey(v.date, v.reportTs)] ?? published[v.date];
    const gateExcluded = b
      ? v.roster.filter((n) => !(b.paidRoster ?? v.roster).includes(n))
      : v.roster.filter((n) => owesDroneSubmission(n, qa?.droneSubmitters ?? [], v.date));
    const sm = startMinutes(v.deployWindow);
    return {
      date: v.date,
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
      gateExcluded,
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
  const { anchor, details } = buildMonthSummary(args.period, args.today, days);
  const key = periodKey(args.period);
  const scope = args.threadTs ? `:${args.threadTs}` : "";
  const meta = (part: string) => ({
    key: `field-summary:${key}:${args.today}${scope}:${part}`,
    feature: "field-summary",
    channel: channel.name,
    trigger: args.trigger,
  });
  const anchorTs = await postMessage(channel.id, anchor, meta("anchor"), args.threadTs);
  // Day lines hang under the anchor (new post) or under the existing thread root.
  const threadRoot = args.threadTs ?? anchorTs;
  for (const [i, d] of details.entries()) {
    await postMessage(channel.id, d, meta(`t${i + 1}`), threadRoot);
  }
  return { anchorTs, replies: details.length, days: days.length };
}
