/** Pure CLI helpers for field-bonus: arg parsing, period defaulting, CSV + table. */
import { parsePeriodKey, type Period } from "../lib/period";
import type { BonusReport, DayBonus } from "../lib/fieldBonus";
import { dayPersonBonuses, type PersonAmount } from "../lib/bonusNotify";
import { isDmSentFor, type NotifiedLog } from "../lib/bonusNotified";
import { isPublished, type PublishedLog } from "../lib/published";
import { reportKey, type VerdictStatus } from "../lib/fieldDayVerdict";

export interface BonusArgs { start?: string; end?: string; format?: string; write: boolean; ask: boolean; publish: boolean; notify: boolean; retractThreads: boolean; channel?: string; sheet?: string }

export function parseArgs(argv: string[]): BonusArgs {
  const args: BonusArgs = { write: false, ask: false, publish: false, notify: false, retractThreads: false };
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
    else if (a === "--retract-threads") args.retractThreads = true;
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
  const lines = [head, ...rows];
  if (report.pendingDays.length) {
    lines.push("", "pending,date,reportTs,status,roster,amountAtStake");
    for (const d of report.pendingDays) lines.push(`pending,${d.date},${d.reportTs ?? ""},${d.status},"${d.roster.join(", ")}",${d.amountAtStake}`);
  }
  return lines.join("\n");
}

export function formatTable(report: BonusReport): string {
  const lines = [`Field bonuses ${report.period.start}..${report.period.end}${report.teamZeroed ? " — TEAM ZEROED (>3 losses)" : ""}`];
  for (const p of report.people) lines.push(`  ${p.name.padEnd(14)} trips=${p.trips} early=${p.early} wknd=${p.weekend} gross=${p.gross} pen=${p.penaltyPct * 100}% net=${p.net}`);
  lines.push(`  TOTAL net=${report.total}`);
  if (report.flags.length) { lines.push("Flags:"); for (const f of report.flags) lines.push(`  [${f.kind}] ${f.date} ${f.detail}`); }
  if (report.pendingDays.length) {
    lines.push("Pending review:");
    for (const d of report.pendingDays) lines.push(`  ${d.date}  ${d.status}  ${d.roster.join(", ") || "(no crew)"} — ₴${d.amountAtStake} at stake (${d.reasons.join("; ")})`);
  }
  if (report.voidedDays.length) {
    lines.push("Voided (rejected):");
    for (const d of report.voidedDays) lines.push(`  ${d.date}  ${d.roster.join(", ") || "(no crew)"} — ${d.reason}`);
  }
  return lines.join("\n");
}

export interface NotifyTarget { name: string; amount: PersonAmount; slackId: string | null }

export interface NotifyPlanItem {
  date: string;
  reportTs: string | null;
  reportCount: number;
  earned: boolean;
  reason: string;
  people: PersonAmount[];
  pendingDms: NotifyTarget[];
  unmatched: string[];
  published: boolean;
}

/**
 * Which settled, EARNED reports still owe someone a DM. A report qualifies iff
 * its verdict is FINAL and accepted (ACCEPTED / ACCEPTED_EXCEPTION) and the
 * bonus DayBonus is counted; PENDING and NEEDS_REVIEW are skipped (NEEDS_REVIEW
 * may still flip to an exception), and a REJECTED report owes nothing — since
 * 2026-09-05 money is DM-only, so there is no thread breakdown and no in-thread
 * «бонус не нараховано» note either (the verdict message already says why).
 * Fully-DMed reports are dropped. Verdict/notified/published lookups are all
 * report-scoped (reportKey(date, reportTs)) with the same legacy bare-date
 * fallback for single-report days.
 */
export function buildNotifyPlan(input: {
  days: DayBonus[];
  verdictByReport: Map<string, VerdictStatus>;
  published: PublishedLog;
  slackIdByName: Map<string, string | null>;
  log: NotifiedLog;
}): NotifyPlanItem[] {
  const { days, verdictByReport, published, slackIdByName, log } = input;
  const plan: NotifyPlanItem[] = [];
  for (const day of days) {
    const target = { date: day.date, reportTs: day.reportTs, reportCount: day.reportCount };
    const status = verdictByReport.get(reportKey(day.date, day.reportTs));
    if (!status || status === "PENDING" || status === "NEEDS_REVIEW") continue; // only final statuses
    const people = dayPersonBonuses(day);
    const accepted = status === "ACCEPTED" || status === "ACCEPTED_EXCEPTION";
    const earned = accepted && people.length > 0;
    const reason = accepted ? day.reason : "виїзд відхилено";
    if (!earned) continue;

    const pendingDms: NotifyTarget[] = [];
    const unmatched: string[] = [];
    for (const amount of people) {
      const slackId = slackIdByName.get(amount.name) ?? null;
      if (slackId === null) { unmatched.push(amount.name); continue; }
      if (isDmSentFor(log, target, slackId)) continue;
      pendingDms.push({ name: amount.name, amount, slackId });
    }
    if (pendingDms.length === 0 && unmatched.length === 0) continue;
    plan.push({
      date: day.date, reportTs: day.reportTs, reportCount: day.reportCount,
      earned, reason, people, pendingDms, unmatched,
      published: isPublished(published, target),
    });
  }
  return plan;
}

/** The in-thread bonus posts (💰 breakdown / ℹ️ no-bonus note) a period still
 *  carries — the retract targets. Money is DM-only since 2026-09-05, so every
 *  one of these is a message the bot should not have in the verdict thread. */
export function buildRetractPlan(log: NotifiedLog): { key: string; date: string; threadTs: string }[] {
  return Object.entries(log)
    .filter(([, e]) => e.threadTs != null)
    .map(([key, e]) => ({ key, date: e.date, threadTs: e.threadTs as string }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function formatRetractDryRun(plan: { key: string; date: string; threadTs: string }[], channel?: string): string {
  const target = channel ? `#${channel}` : "(no channel — pass --channel <name>)";
  const lines = [`DRY RUN — would delete ${plan.length} in-thread bonus message(s) in ${target}`, ""];
  for (const p of plan) lines.push(`${p.date}  ${p.key}  ts=${p.threadTs}`);
  lines.push("", "Nothing was deleted. Re-run with `--retract-threads --publish --channel <name>` to delete for real.");
  return lines.join("\n");
}

export function formatNotifyDryRun(plan: NotifyPlanItem[]): string {
  const dms = plan.reduce((n, p) => n + p.pendingDms.length, 0);
  const lines = [`DRY RUN — would send ${dms} DM(s) (money is DM-only; nothing is posted in the verdict thread)`, ""];
  for (const item of plan) {
    const head = `${item.people.reduce((s, p) => s + p.total, 0)} грн`;
    lines.push(`${item.date} — ${head}${item.published ? "" : "  [NOT PUBLISHED — DMs wait for the verdict post]"}`);
    for (const t of item.pendingDms) lines.push(`    DM → ${t.name} (${t.slackId}): ${t.amount.total} грн`);
    for (const n of item.unmatched) lines.push(`    ⚠ no Slack id for ${n} — DM skipped, add to SLACK_ID_OVERRIDES`);
  }
  lines.push("", "No messages were sent. Re-run with `--notify --publish` to send for real.");
  return lines.join("\n");
}
