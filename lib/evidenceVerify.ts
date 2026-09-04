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

/**
 * The verdict row a thread target refers to. PURE (the CLI's dry-run preview
 * reuses it, so the runtime and the preview can never disagree).
 *
 * A date-only fallback is safe only for a day-level target (no reportTs) — an
 * ask thread or a legacy entry. When the target names a specific report and no
 * row matches it exactly, another report on the same day must never stand in
 * for it. On a MULTI-report day the day-level target picks the first row that is
 * NOT already accepted: evidence posted in an ask thread is about the report
 * that still has a gap, and answering with the neighbouring accepted row would
 * tell the pilot «день прийнято» while their own report stays open. All rows
 * accepted → the first row (the answer is the same either way).
 */
export function findVerdictRow(days: DayVerdict[] | undefined, date: string, reportTs: string | null): DayVerdict | null {
  const exact = days?.find((d) => reportKey(d.date, d.reportTs) === reportKey(date, reportTs));
  if (exact) return exact;
  if (reportTs !== null) return null;
  const onDate = days?.filter((d) => d.date === date) ?? [];
  return onDate.find((d) => d.status !== "ACCEPTED" && d.status !== "ACCEPTED_EXCEPTION") ?? onDate[0] ?? null;
}

export async function verifyEvidence(a: VerifyArgs): Promise<VerifyResult> {
  const log = a.onLog ?? (() => {});
  const before = findVerdictRow((await readReportJson<{ days: DayVerdict[] }>("field-verdict", periodKey(a.period)))?.days, a.date, a.reportTs);

  // Guard: computeVerdicts recomputes from the committed field-qa report. When
  // that report doesn't exist yet, it still runs — every row gets airborne 0,
  // lands NEEDS_REVIEW, and gets WRITTEN — and refreshPublishedDays would then
  // rewrite the day's live Slack message with that nonsense. Bail before any
  // of sync/recompute/refresh runs.
  const fq = await readReportJson<{ days: unknown[] }>("field-qa", periodKey(a.period));
  if (!fq) {
    return {
      outcome: "still_open",
      text: "❌ Не вдалося перевірити: немає обробленого звіту #field-qa за цей період — спробуйте пізніше або напишіть затверджувачам.",
      verifyLine: "звіт field-qa відсутній",
      statusBefore: before?.status ?? null,
      statusAfter: before?.status ?? null,
    };
  }

  const datasets = TRACKED_CHANNELS.find((c) => c.name === "datasets");
  if (datasets) await syncAllChannels({ mode: "incremental", window: 7, channels: [datasets], onLog: log });

  const report = await computeVerdicts(a.period, { write: true, onLog: log });
  const dayRows = report.days.filter((d) => d.date === a.date);
  await refreshPublishedDays(dayRows, a.period, { trigger: a.trigger, onLog: log });
  const after = findVerdictRow(dayRows, a.date, a.reportTs);

  // Both lookups below only enrich the answer with a CAUSE hint, and they run
  // after the recompute + refresh have already (possibly) flipped the day. A
  // throw here would let the caller report «не вдалося перевірити» over a
  // verification that in fact happened — so each one soft-fails and we answer
  // with whatever diagnostics we have.
  const linkedVideos: LinkedVideo[] = [];
  if (a.hints.vimeoLinks.length) {
    try {
      const videos = await fetchVideosInPeriod(a.period.start, a.period.end);
      for (const l of a.hints.vimeoLinks) {
        const idBoundary = new RegExp(`/${l.id}(?!\\d)`);
        const v = videos.find((x) => idBoundary.test(x.link));
        if (v) linkedVideos.push({ id: l.id, name: v.name, created_time: v.created_time, link: v.link });
      }
    } catch (err) {
      console.error("verifyEvidence: Vimeo link lookup failed (diagnostics only):", err);
      log(`verifyEvidence: Vimeo lookup failed — answering without video diagnostics (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  const datasetLinkDates = new Map<string, string>();
  if (a.hints.datasetPermalinks.length) {
    try {
      const msgs = await readChannelMessages("datasets", a.period);
      for (const p of a.hints.datasetPermalinks) {
        const m = msgs.find((x) => x.ts === p.ts);
        if (m) datasetLinkDates.set(p.ts, m.isoTime.slice(0, 10));
      }
    } catch (err) {
      console.error("verifyEvidence: #datasets permalink lookup failed (diagnostics only):", err);
      log(`verifyEvidence: #datasets lookup failed — answering without dataset diagnostics (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  const res = evidenceOutcome({ day: after, byName: a.byName, hints: a.hints, linkedVideos, datasetLinkDates });
  return { ...res, statusBefore: before?.status ?? null, statusAfter: after?.status ?? null };
}
