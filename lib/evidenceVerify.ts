/**
 * Verification stage (pilot evidence autonomy, spec §4): the ONLY path that can
 * accept a day without a human, and it does so purely by re-running the live
 * verdict (sync #datasets → computeVerdicts → refreshPublishedDays). No new
 * decision logic. SERVER-ONLY (Vimeo + Slack + DB).
 */
import "server-only";
import { syncAllChannels } from "./syncChannels";
import { computeVerdicts } from "./computeVerdicts";
import { refreshPublishedDays } from "./refreshPublished";
import { readReportJson, periodKey } from "./reports";
import { fetchVideosInPeriod } from "./vimeo";
import { readChannelMessages } from "./slackMirror";
import { TRACKED_CHANNELS } from "./slackChannels";
import { reportKey, type DayVerdict } from "./fieldDayVerdict";
import { evidenceOutcome, type EvidenceOutcomeKind, type LinkedVideo } from "./evidenceOutcome";
import type { ReplyHints } from "./threadReplyHints";
import type { SendTrigger } from "./outboundKeys";
import type { Period } from "./period";

export interface VerifyArgs {
  date: string;
  reportTs: string | null;
  period: Period;
  hints: ReplyHints;
  byName: string;
  trigger: SendTrigger;
  onLog?: (m: string) => void;
}
export interface VerifyResult {
  outcome: EvidenceOutcomeKind;
  text: string;
  verifyLine: string;
  statusBefore: string | null;
  statusAfter: string | null;
}

const findRow = (days: DayVerdict[] | undefined, date: string, reportTs: string | null): DayVerdict | null =>
  days?.find((d) => reportKey(d.date, d.reportTs) === reportKey(date, reportTs)) ??
  days?.find((d) => d.date === date) ?? null;

export async function verifyEvidence(a: VerifyArgs): Promise<VerifyResult> {
  const log = a.onLog ?? (() => {});
  const before = findRow((await readReportJson<{ days: DayVerdict[] }>("field-verdict", periodKey(a.period)))?.days, a.date, a.reportTs);

  const datasets = TRACKED_CHANNELS.find((c) => c.name === "datasets");
  if (datasets) await syncAllChannels({ mode: "incremental", window: 7, channels: [datasets], onLog: log });

  const report = await computeVerdicts(a.period, { write: true, onLog: log });
  const dayRows = report.days.filter((d) => d.date === a.date);
  await refreshPublishedDays(dayRows, a.period, { trigger: a.trigger, onLog: log });
  const after = findRow(dayRows, a.date, a.reportTs);

  const linkedVideos: LinkedVideo[] = [];
  if (a.hints.vimeoLinks.length) {
    const videos = await fetchVideosInPeriod(a.period.start, a.period.end);
    for (const l of a.hints.vimeoLinks) {
      const v = videos.find((x) => x.link.includes(`/${l.id}`));
      if (v) linkedVideos.push({ id: l.id, name: v.name, created_time: v.created_time, link: v.link });
    }
  }
  const datasetLinkDates = new Map<string, string>();
  if (a.hints.datasetPermalinks.length) {
    const msgs = await readChannelMessages("datasets", a.period);
    for (const p of a.hints.datasetPermalinks) {
      const m = msgs.find((x) => x.ts === p.ts);
      if (m) datasetLinkDates.set(p.ts, m.isoTime.slice(0, 10));
    }
  }

  const res = evidenceOutcome({ day: after, byName: a.byName, hints: a.hints, linkedVideos, datasetLinkDates });
  return { ...res, statusBefore: before?.status ?? null, statusAfter: after?.status ?? null };
}
