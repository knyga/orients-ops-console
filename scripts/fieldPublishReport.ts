/**
 * Pure CLI shaping for the verdict publisher (S4): arg parsing, period
 * resolution, the publish PLAN (which days to post vs already-posted), and the
 * dry-run rendering. No server/Next/fs imports — unit-tested. Domain formatting
 * lives in ../lib/verdictPublish.
 */
import type { DayVerdict } from "../lib/fieldDayVerdict";
import { formatDayMessage, publishableDays } from "../lib/verdictPublish";
import { isPublished, type PublishedLog } from "../lib/published";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface Period {
  start: string;
  end: string;
}

export interface PublishArgs {
  start?: string;
  end?: string;
  /** Target channel NAME (must be a tracked channel). */
  channel?: string;
  /** Actually post. Default false = dry-run (print only, write nothing). */
  publish: boolean;
}

export interface PlanItem {
  date: string;
  text: string;
  alreadyPublished: boolean;
}

export function parseArgs(argv: string[]): PublishArgs {
  const args: PublishArgs = { publish: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--start") { args.start = value; i += 1; }
    else if (flag === "--end") { args.end = value; i += 1; }
    else if (flag === "--channel") { args.channel = value; i += 1; }
    else if (flag === "--publish") { args.publish = true; }
  }
  return args;
}

export function defaultMonthWindow(today: string): Period {
  return { start: `${today.slice(0, 7)}-01`, end: today };
}

export function resolvePeriod(args: PublishArgs, today: string): Period {
  let start = args.start;
  let end = args.end;
  if (!start || !end) ({ start, end } = defaultMonthWindow(today));
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new Error(`Period bounds must be YYYY-MM-DD: start=${start} end=${end}`);
  }
  return { start, end };
}

/**
 * The publish plan: one item per publishable day (settled verdicts), each with
 * the message text and whether it was already posted (idempotency). Pure.
 */
export function buildPlan(days: DayVerdict[], log: PublishedLog): PlanItem[] {
  return publishableDays(days).map((d) => ({
    date: d.date,
    text: formatDayMessage(d),
    alreadyPublished: isPublished(log, d.date),
  }));
}

/** Items that would actually be posted (publishable AND not already posted). */
export function pendingItems(plan: PlanItem[]): PlanItem[] {
  return plan.filter((p) => !p.alreadyPublished);
}

/** Human-readable dry-run output: exactly what would be posted and where. */
export function formatDryRun(plan: PlanItem[], channel: string | undefined, period: Period): string {
  const pending = pendingItems(plan);
  const skipped = plan.length - pending.length;
  const target = channel ? `#${channel}` : "(no channel — pass --channel <name>)";
  const lines: string[] = [];
  lines.push(`DRY RUN — would post ${pending.length} verdict(s) to ${target}   [${period.start} … ${period.end}]`);
  lines.push(`(${skipped} already published, skipped; ${plan.length} publishable total)`);
  lines.push("");
  if (pending.length === 0) {
    lines.push("Nothing new to post.");
  } else {
    for (const p of pending) lines.push(`  ${p.text}`);
  }
  lines.push("");
  lines.push("No messages were sent. Re-run with `--publish --channel <name>` to post for real (needs chat:write).");
  return lines.join("\n");
}
