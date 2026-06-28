/** Pure CLI helpers for field-bonus: arg parsing, period defaulting, CSV + table. */
import { parsePeriodKey, type Period } from "../lib/period";
import type { BonusReport, DayBonus } from "../lib/fieldBonus";
import { dayPersonBonuses, type PersonAmount } from "../lib/bonusNotify";
import { isThreadNotified, isDmSent, type NotifiedLog } from "../lib/bonusNotified";
import type { VerdictStatus } from "../lib/fieldDayVerdict";

export interface BonusArgs { start?: string; end?: string; format?: string; write: boolean; ask: boolean; publish: boolean; notify: boolean; channel?: string; sheet?: string }

export function parseArgs(argv: string[]): BonusArgs {
  const args: BonusArgs = { write: false, ask: false, publish: false, notify: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--start") args.start = argv[++i];
    else if (a === "--end") args.end = argv[++i];
    else if (a === "--format") args.format = argv[++i];
    else if (a === "--sheet") args.sheet = argv[++i];
    else if (a === "--write") args.write = true;
    else if (a === "--ask") args.ask = true;
    else if (a === "--publish") args.publish = true;
    else if (a === "--notify") args.notify = true;
    else if (a === "--channel") args.channel = argv[++i];
  }
  return args;
}

export function resolvePeriod(args: BonusArgs, today: string): Period {
  if (args.start && args.end) return { start: args.start, end: args.end };
  const month = today.slice(0, 7);
  return parsePeriodKey(month)!;
}

export function toCsv(report: BonusReport): string {
  const head = "person,trips,early,weekend,gross,penaltyPct,net";
  const rows = report.people.map((p) => [p.name, p.trips, p.early, p.weekend, p.gross, p.penaltyPct, p.net].join(","));
  return [head, ...rows].join("\n");
}

export function formatTable(report: BonusReport): string {
  const lines = [`Field bonuses ${report.period.start}..${report.period.end}${report.teamZeroed ? " — TEAM ZEROED (>3 losses)" : ""}`];
  for (const p of report.people) lines.push(`  ${p.name.padEnd(14)} trips=${p.trips} early=${p.early} wknd=${p.weekend} gross=${p.gross} pen=${p.penaltyPct * 100}% net=${p.net}`);
  lines.push(`  TOTAL net=${report.total}`);
  if (report.flags.length) { lines.push("Flags:"); for (const f of report.flags) lines.push(`  [${f.kind}] ${f.date} ${f.detail}`); }
  return lines.join("\n");
}

export interface NotifyTarget { name: string; amount: PersonAmount; slackId: string | null }

export interface NotifyPlanItem {
  date: string;
  earned: boolean;
  reason: string;
  people: PersonAmount[];
  threadPending: boolean;
  pendingDms: NotifyTarget[];
  unmatched: string[];
  published: boolean;
}

/**
 * Which settled days still need a thread post and/or DMs. A day is in the plan
 * iff its verdict has settled (≠ PENDING). Earned = the bonus DayBonus is
 * counted. PENDING days and fully-notified days are dropped.
 */
export function buildNotifyPlan(input: {
  days: DayBonus[];
  verdictByDate: Map<string, VerdictStatus>;
  publishedDates: Set<string>;
  slackIdByName: Map<string, string | null>;
  log: NotifiedLog;
}): NotifyPlanItem[] {
  const { days, verdictByDate, publishedDates, slackIdByName, log } = input;
  const plan: NotifyPlanItem[] = [];
  for (const day of days) {
    const status = verdictByDate.get(day.date);
    if (!status || status === "PENDING") continue; // only settled days, rolling
    const people = dayPersonBonuses(day);
    const earned = people.length > 0;
    const threadPending = !isThreadNotified(log, day.date);

    const pendingDms: NotifyTarget[] = [];
    const unmatched: string[] = [];
    if (earned) {
      for (const amount of people) {
        const slackId = slackIdByName.get(amount.name) ?? null;
        if (slackId === null) { unmatched.push(amount.name); continue; }
        if (isDmSent(log, day.date, slackId)) continue;
        pendingDms.push({ name: amount.name, amount, slackId });
      }
    }
    if (!threadPending && pendingDms.length === 0 && unmatched.length === 0) continue;
    plan.push({ date: day.date, earned, reason: day.reason, people, threadPending, pendingDms, unmatched, published: publishedDates.has(day.date) });
  }
  return plan;
}

export function formatNotifyDryRun(plan: NotifyPlanItem[], channel?: string): string {
  const threads = plan.filter((p) => p.threadPending).length;
  const dms = plan.reduce((n, p) => n + p.pendingDms.length, 0);
  const target = channel ? `#${channel}` : "(no channel — pass --channel <name>)";
  const lines = [`DRY RUN — would post ${threads} thread message(s) + ${dms} DM(s) to ${target}`, ""];
  for (const item of plan) {
    const head = item.earned ? `${item.people.reduce((s, p) => s + p.total, 0)} грн` : `no bonus (${item.reason})`;
    lines.push(`${item.date} — ${head}${item.published ? "" : "  [NOT PUBLISHED — thread skipped]"}`);
    for (const t of item.pendingDms) lines.push(`    DM → ${t.name} (${t.slackId}): ${t.amount.total} грн`);
    for (const n of item.unmatched) lines.push(`    ⚠ no Slack id for ${n} — DM skipped, add to SLACK_ID_OVERRIDES`);
  }
  lines.push("", "No messages were sent. Re-run with `--notify --publish --channel <name>` to send for real.");
  return lines.join("\n");
}
