/**
 * Pure CLI shaping for the ask-for-missing-info command (S5): arg parsing, period
 * resolution, the ask PLAN (askable gaps vs already-asked), and the dry-run
 * rendering. No server/Next/fs imports — unit-tested. Gap derivation lives in
 * ../lib/askGaps; the ask-once log in ../lib/asks.
 */
import type { DayVerdict } from "../lib/fieldDayVerdict";
import { gapKey, gapsForDay, type Gap } from "../lib/askGaps";
import { isAsked, type AskLog } from "../lib/asks";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface Period {
  start: string;
  end: string;
}

export interface AskArgs {
  start?: string;
  end?: string;
  /** Actually post questions. Default false = dry-run (print only). */
  publish: boolean;
}

export interface AskItem {
  gap: Gap;
  key: string;
  alreadyAsked: boolean;
}

export function parseArgs(argv: string[]): AskArgs {
  const args: AskArgs = { publish: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--start") { args.start = value; i += 1; }
    else if (flag === "--end") { args.end = value; i += 1; }
    else if (flag === "--publish") { args.publish = true; }
  }
  return args;
}

export function defaultMonthWindow(today: string): Period {
  return { start: `${today.slice(0, 7)}-01`, end: today };
}

export function resolvePeriod(args: AskArgs, today: string): Period {
  let start = args.start;
  let end = args.end;
  if (!start || !end) ({ start, end } = defaultMonthWindow(today));
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new Error(`Period bounds must be YYYY-MM-DD: start=${start} end=${end}`);
  }
  return { start, end };
}

/** All askable gaps across the days, each tagged with its key + already-asked. */
export function buildAskPlan(days: DayVerdict[], log: AskLog): AskItem[] {
  const items: AskItem[] = [];
  for (const day of days) {
    for (const gap of gapsForDay(day)) {
      const key = gapKey(gap.gapType, gap.date);
      items.push({ gap, key, alreadyAsked: isAsked(log, key) });
    }
  }
  return items;
}

/** Gaps that would actually be asked (askable AND not already asked). */
export function pendingAsks(plan: AskItem[]): AskItem[] {
  return plan.filter((i) => !i.alreadyAsked);
}

/** Human-readable dry-run output: exactly which questions would be posted where. */
export function formatDryRun(plan: AskItem[], period: Period): string {
  const pending = pendingAsks(plan);
  const skipped = plan.length - pending.length;
  const lines: string[] = [];
  lines.push(`DRY RUN — would ask ${pending.length} question(s)   [${period.start} … ${period.end}]`);
  lines.push(`(${skipped} already asked, skipped; ${plan.length} askable gap(s) total)`);
  lines.push("");
  if (pending.length === 0) {
    lines.push("Nothing new to ask.");
  } else {
    for (const i of pending) {
      lines.push(`  → #${i.gap.channel} [${i.gap.gapType} ${i.gap.date}]`);
      lines.push(`    ${i.gap.question}`);
    }
  }
  lines.push("");
  lines.push("No messages were sent. Re-run with `--publish` to ask for real (needs chat:write).");
  return lines.join("\n");
}
