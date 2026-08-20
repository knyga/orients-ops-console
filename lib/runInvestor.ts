/**
 * Shared weekly-investor-report orchestration, used by BOTH the `npm run
 * investor` CLI and the `/api/cron/investor-report` route (mirrors
 * lib/runSprint.ts). Gathers the previous Mon–Sun week's numbers (Jira live,
 * sprint completion from the sprint store, field-qa/field-verdict from the
 * DB monthly reports, Vimeo live), narrates them via one soft-failing Claude
 * call, stores the record (feature "investor"), and — when publishing — posts
 * the Ukrainian draft to #general via the lib/slack.ts reserve-then-send
 * chokepoint (outbound key `investor:<week>`, so a cron re-fire posts once).
 *
 * Hard failure in any data stage → NO post + best-effort operator DM (the
 * draft must never ship on partial data). A failed Claude summary is soft —
 * the deterministic fallback still posts (humans edit the draft anyway).
 */
import "server-only";
import { APPROVERS } from "./approvers";
import type { DayVerdict } from "./fieldDayVerdict";
import {
  buildWeekData,
  computeWeekWindow,
  formatInvestorMessage,
  monthKeysCovering,
  pickSprintCompletion,
  toInvestorCsv,
  type InvestorRecord,
  type SprintPick,
} from "./investorReport";
import { ORG } from "./github";
import { fetchMergedPrContexts } from "./githubPrContext";
import { writeInvestor } from "./investorStore";
import { generateSummary } from "./investorSummary";
import { fetchResolvedIssues } from "./jira";
import { buildPrGroundingText, DEFAULT_GROUNDING_CAPS } from "./prGrounding";
import { aggregateByUser } from "./jiraStats";
import { investorKey, type SendTrigger } from "./outboundKeys";
import { readReportJson } from "./reports";
import { openDm, postMessage } from "./slack";
import { TRACKED_CHANNELS } from "./slackChannels";
import { listSprintSlugs, readSprint } from "./sprintStore";
import { todayInFieldTz } from "./syncChannels";
import { fetchVideosInPeriod } from "./vimeo";

export interface RunInvestorOptions {
  publish: boolean;
  /** Tracked channel NAME to post to (default "general"). */
  channelName?: string;
  /** Kyiv-date override for tests/backfill (default: today in Kyiv). */
  today?: string;
  trigger?: SendTrigger;
}

export type InvestorResult =
  | {
      status: "ok";
      key: string;
      message: string;
      posted: boolean;
      summarySource: "claude" | "fallback";
      gitContext: InvestorRecord["gitContext"];
    }
  | {
      status: "failed";
      stage: "jira" | "sprint" | "field" | "vimeo" | "store" | "post";
      reason: string;
    };

interface FieldQaMonth {
  days: { date: string; airborneMinutes: number; flew: boolean }[];
}
interface VerdictMonth {
  days: DayVerdict[];
}

/** Best-effort operator DM; a failed DM must not mask the original error.
 *  Keyed by week + stage (not the reason text) so a recurring weekly failure
 *  re-DMs every week instead of deduping to a single lifetime send. */
async function notifyOperator(
  weekKey: string,
  stage: string,
  reason: string,
  trigger: SendTrigger,
): Promise<void> {
  try {
    const dm = await openDm(APPROVERS[0].userId);
    await postMessage(dm, `⛔ Тижневий звіт для інвесторів не сформовано (${stage}): ${reason}`, {
      key: `investor-failure:${weekKey}:${stage}`,
      feature: "investor-failure",
      channel: "dm",
      trigger,
    });
  } catch (e) {
    console.error("runInvestor: operator DM failed:", e);
  }
}

export async function runInvestor(opts: RunInvestorOptions): Promise<InvestorResult> {
  const today = opts.today ?? todayInFieldTz();
  const window = computeWeekWindow(today);
  const channelName = opts.channelName ?? "general";
  const trigger = opts.trigger ?? "unknown";

  const fail = async (
    stage: "jira" | "sprint" | "field" | "vimeo" | "store" | "post",
    err: unknown,
  ): Promise<InvestorResult> => {
    const reason = err instanceof Error ? err.message : String(err);
    if (opts.publish) await notifyOperator(window.key, stage, reason, trigger);
    return { status: "failed", stage, reason };
  };

  // 1. Jira delivery (live).
  let jiraTotals: { totalResolved: number; totalStoryPoints: number };
  let noteworthy: { key: string; summary: string }[];
  try {
    const issues = await fetchResolvedIssues(window.start, window.end);
    jiraTotals = aggregateByUser(issues).totals;
    noteworthy = issues.slice(0, 15).map((i) => ({ key: i.key, summary: i.summary }));
  } catch (e) {
    return fail("jira", e);
  }

  // 2. Sprint completion (from the sprint store; absent → line omitted).
  let sprint: ReturnType<typeof pickSprintCompletion>;
  try {
    const slugs = (await listSprintSlugs()).slice(0, 6);
    const picks: SprintPick[] = [];
    for (const slug of slugs) {
      const rec = await readSprint(slug);
      if (rec?.completed) {
        picks.push({
          name: rec.committed.sprintName,
          computedAt: rec.completed.computedAt,
          rate: rec.completed.result.rate,
          completed: rec.completed.result.completed,
          committed: rec.completed.result.committed,
        });
      }
    }
    sprint = pickSprintCompletion(picks, window);
  } catch (e) {
    return fail("sprint", e);
  }

  // 3. Field data from the DB monthly reports (absent month row → no field
  //    activity recorded — legitimate; a thrown read is a hard fail).
  let fieldQaDays: FieldQaMonth["days"] = [];
  let verdictDays: DayVerdict[] = [];
  try {
    for (const monthKey of monthKeysCovering(window)) {
      const fq = await readReportJson<FieldQaMonth>("field-qa", monthKey);
      if (fq?.days) fieldQaDays = fieldQaDays.concat(fq.days);
      const vr = await readReportJson<VerdictMonth>("field-verdict", monthKey);
      if (vr?.days) verdictDays = verdictDays.concat(vr.days);
    }
  } catch (e) {
    return fail("field", e);
  }

  // 4. Video (live Vimeo).
  let videos: { duration: number }[];
  try {
    videos = await fetchVideosInPeriod(window.start, window.end);
  } catch (e) {
    return fail("vimeo", e);
  }

  // 4b. Git grounding (SOFT-fail by design): the week's merged PRs across all
  //     org repos — description, comments, diff — fed to the summary call as a
  //     source of facts. Any failure (missing GH_ACCESS_TOKEN, API error) only
  //     drops the grounding; the report still posts, narrated as before. Only
  //     metadata is stored — raw diffs never hit the record.
  let gitGrounding: string | undefined;
  let gitContext: InvestorRecord["gitContext"];
  const ghToken = process.env.GH_ACCESS_TOKEN;
  if (ghToken) {
    try {
      const prs = await fetchMergedPrContexts({
        token: ghToken,
        org: ORG,
        start: window.start,
        end: window.end,
        maxPrs: DEFAULT_GROUNDING_CAPS.maxPrs,
      });
      const grounding = buildPrGroundingText(prs);
      gitGrounding = grounding.text || undefined;
      gitContext = grounding.meta;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error("runInvestor: git grounding failed (soft, report posts without it):", reason);
      gitContext = { prCount: 0, included: [], totalChars: 0, truncated: false, error: reason };
    }
  } else {
    gitContext = {
      prCount: 0,
      included: [],
      totalChars: 0,
      truncated: false,
      error: "GH_ACCESS_TOKEN is not set",
    };
  }

  const data = buildWeekData({
    window,
    jiraTotals,
    noteworthy,
    sprint,
    fieldQaDays,
    verdictDays,
    videos,
  });

  // 5. Summary (soft-fail → deterministic fallback inside generateSummary).
  const summary = await generateSummary(data, gitGrounding);
  const message = formatInvestorMessage(summary.text, data);

  const record: InvestorRecord = {
    data,
    summary: summary.text,
    summarySource: summary.source,
    message,
    generatedAt: new Date().toISOString(),
    gitContext,
  };

  // 6. Store (both dry-run and publish — the web tab renders the latest record).
  try {
    await writeInvestor(window.key, record, toInvestorCsv(data));
  } catch (e) {
    return fail("store", e);
  }

  // 7. Post (publish only; deduped by the week key at the slack chokepoint).
  let posted = false;
  if (opts.publish) {
    const channel = TRACKED_CHANNELS.find((c) => c.name === channelName);
    if (!channel) return fail("post", new Error(`unknown tracked channel "${channelName}"`));
    try {
      await postMessage(channel.id, message, {
        key: investorKey(window.key),
        feature: "investor",
        channel: channel.name,
        trigger: opts.trigger ?? "unknown",
      });
    } catch (e) {
      return fail("post", e);
    }
    posted = true;
  }

  return {
    status: "ok",
    key: window.key,
    message,
    posted,
    summarySource: summary.source,
    gitContext,
  };
}
