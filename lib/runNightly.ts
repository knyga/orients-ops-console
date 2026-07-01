/**
 * Shared orchestration for the autonomous nightly field pipeline. SERVER-ONLY.
 * Runs sync → (per window month: extract → verdict) → (per window month:
 * publish), called by BOTH /api/cron/field-nightly (publish:true) and the
 * `field-nightly` CLI (dry-run default). Sequential + in-process: any stage
 * failure short-circuits BEFORE publishing, so the bot never posts on stale or
 * partial data. On failure (or an "extracted days but the verdict pass produced
 * nothing" anomaly) it DMs the operator best-effort, then rethrows so the caller
 * can return HTTP 500. Dry-run neither posts nor DMs.
 */
import "server-only";
import { syncAllChannels, todayInFieldTz } from "./syncChannels";
import { FIELD_TIMEZONE } from "./reconcile";
import { windowMonths } from "./nightlyWindow";
import { extractFieldQa } from "./fieldQaExtract";
import { computeVerdicts } from "./computeVerdicts";
import { publishSettledDays } from "./publishVerdicts";
import { periodKey, readReportJson } from "./reports";
import { TRACKED_CHANNELS } from "./slackChannels";
import { APPROVERS } from "./approvers";
import { openDm, postMessage } from "./slack";
import { formatNightlyFailureNotice } from "./nightlyNotice";

const FIELD_QA = "field-qa";

export interface NightlyMonthResult {
  period: { start: string; end: string };
  extractedDays: number;
  posted: string[];
  skipped: string[];
}

export interface NightlySummary {
  publish: boolean;
  months: NightlyMonthResult[];
}

export interface RunNightlyOptions {
  publish: boolean;
  today?: string;
  onLog?: (message: string) => void;
}

/** Best-effort operator DM; a failed DM must not mask the original error. */
async function notifyOperator(stage: string, reason: string, log: (m: string) => void): Promise<void> {
  try {
    const dm = await openDm(APPROVERS[0].userId);
    await postMessage(dm, formatNightlyFailureNotice(stage, reason), {
      key: `field-nightly-failure:${stage}:${reason.slice(0, 40)}`,
      feature: "nightly-failure",
      channel: "dm",
      trigger: "cron",
    });
  } catch (e) {
    log(`field-nightly: operator DM failed — ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function runNightly(opts: RunNightlyOptions): Promise<NightlySummary> {
  const log = opts.onLog ?? (() => {});
  const today = opts.today ?? todayInFieldTz();
  const channel = TRACKED_CHANNELS.find((c) => c.name === FIELD_QA);
  if (!channel) throw new Error(`field-nightly: no tracked channel "${FIELD_QA}"`);

  let stage = "sync";
  try {
    // 1. Sync once for the whole run.
    await syncAllChannels({ mode: "incremental", window: 7, onLog: log });

    // 2. Per window month: extract → verdict (compute even in dry-run; it does not post).
    // extractFieldQa's report period carries a timezone; computeVerdicts and
    // publishSettledDays only read start/end, so one timezone-carrying period is
    // safe for all three.
    stage = "extract/verdict";
    const window = windowMonths(today);
    const computed = [];
    for (const [i, wm] of window.entries()) {
      const period = { start: wm.start, end: wm.end, timezone: FIELD_TIMEZONE };
      // Always re-extract the NEWEST (current) month. For older catch-up months,
      // reuse the committed field-qa report when it already exists: re-running the
      // Claude vision extraction over a whole prior month on every boundary day is
      // the dominant cost and blows the Hobby 60s function cap. computeVerdicts
      // reads that committed report either way, so publishing still catches up; a
      // late-arriving prior-month report is picked up once its report is absent.
      const isNewest = i === window.length - 1;
      let extractedDays: number;
      if (!isNewest) {
        const existing = await readReportJson<{ days: unknown[] }>("field-qa", periodKey(period));
        if (existing) {
          extractedDays = existing.days.length;
          log(`field-nightly: reusing committed field-qa/${periodKey(period)} (${extractedDays} days) — skip re-extraction`);
        } else {
          extractedDays = (await extractFieldQa(period, { write: true, onLog: log })).days.length;
        }
      } else {
        extractedDays = (await extractFieldQa(period, { write: true, onLog: log })).days.length;
      }
      const report = await computeVerdicts(period, { today, write: true, onLog: log });
      computed.push({ period, extractedDays, report });
    }

    // 3. Per window month: publish settled days (only when publishing for real).
    stage = "publish";
    const months: NightlyMonthResult[] = [];
    for (const c of computed) {
      let posted: string[] = [];
      let skipped: string[] = [];
      if (opts.publish) {
        ({ posted, skipped } = await publishSettledDays(c.report.days, channel, c.period, { onLog: log }));
      } else {
        log(`field-nightly (dry-run): would publish settled days for ${c.period.start}..${c.period.end}`);
      }
      // Anomaly worth alerting on: extraction found flight days for this month but
      // the verdict pass produced NO days at all — a silent integration break
      // (e.g. the field-qa report the verdict reads never landed). This is NOT the
      // benign "all days still PENDING" case, which yields report.days.length > 0.
      // DM only when actually publishing; a dry-run stays quiet.
      if (opts.publish && c.extractedDays > 0 && c.report.days.length === 0) {
        await notifyOperator(
          "publish",
          `extracted ${c.extractedDays} day(s) for ${c.period.start}..${c.period.end} but the verdict report has 0 days`,
          log,
        );
      }
      months.push({
        period: { start: c.period.start, end: c.period.end },
        extractedDays: c.extractedDays,
        posted,
        skipped,
      });
    }

    return { publish: opts.publish, months };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (opts.publish) await notifyOperator(stage, reason, log);
    throw error;
  }
}
