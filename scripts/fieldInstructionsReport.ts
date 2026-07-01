/**
 * Pure CLI shaping for `field-instructions`: arg parsing, period resolution, the
 * day-window filter (the fix for readPublished being period-MONTH keyed), and the
 * manual-instruction builder. No server/Next imports — unit-tested; the effects
 * live in ../lib/applyInstruction + the events route.
 */
import type { InstructionAxis, InstructionClassification } from "../lib/instructionClassifyPrompt";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface Period {
  start: string;
  end: string;
}

export interface ParsedArgs {
  start?: string;
  end?: string;
  write: boolean;
  list: boolean;
  // manual mode
  date?: string;
  setCrew?: string[];
  addCrew?: string[];
  removeCrew?: string[];
  airborne?: number;
  accept?: boolean;
  reject?: boolean;
  by?: string;
  reason?: string;
}

const names = (v: string | undefined): string[] | undefined =>
  v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

export function parseArgs(argv: string[]): ParsedArgs {
  const a: ParsedArgs = { write: false, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--start") { a.start = value; i += 1; }
    else if (flag === "--end") { a.end = value; i += 1; }
    else if (flag === "--write") { a.write = true; }
    else if (flag === "--list") { a.list = true; }
    else if (flag === "--date") { a.date = value; i += 1; }
    else if (flag === "--set-crew") { a.setCrew = names(value); i += 1; }
    else if (flag === "--add-crew") { a.addCrew = names(value); i += 1; }
    else if (flag === "--remove-crew") { a.removeCrew = names(value); i += 1; }
    else if (flag === "--airborne") { a.airborne = Number(value); i += 1; }
    else if (flag === "--accept") { a.accept = true; }
    else if (flag === "--reject") { a.reject = true; }
    else if (flag === "--by") { a.by = value; i += 1; }
    else if (flag === "--reason") { a.reason = value; i += 1; }
  }
  return a;
}

export function defaultMonthWindow(today: string): Period {
  return { start: `${today.slice(0, 7)}-01`, end: today };
}

export function resolvePeriod(args: { start?: string; end?: string; date?: string }, today: string): Period {
  // A --date implies a single-day window.
  if (args.date) {
    if (!DATE_RE.test(args.date)) throw new Error(`--date must be YYYY-MM-DD: ${args.date}`);
    return { start: args.date, end: args.date };
  }
  let start = args.start;
  let end = args.end;
  if (!start || !end) ({ start, end } = defaultMonthWindow(today));
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new Error(`Period bounds must be YYYY-MM-DD: start=${start} end=${end}`);
  }
  return { start, end };
}

/** Keep only entries whose flight date is within [start, end] inclusive.
 *  readPublished is keyed by period-MONTH, so a day-scoped run must filter here. */
export function filterEntriesToWindow<T extends { date: string }>(entries: T[], start: string, end: string): T[] {
  return entries.filter((e) => e.date >= start && e.date <= end).sort((a, b) => a.date.localeCompare(b.date));
}

export interface ManualSpec {
  setCrew?: string[];
  addCrew?: string[];
  removeCrew?: string[];
  airborne?: number;
  accept?: boolean;
  reject?: boolean;
  reason?: string;
}

/** Turn manual CLI flags into a single instruction (or null when none given). */
export function buildManualInstruction(
  spec: ManualSpec,
): { axis: InstructionAxis; instruction: InstructionClassification } | null {
  const reason = spec.reason ?? "manual correction";
  if (spec.setCrew?.length) {
    return { axis: "crew", instruction: { intent: "instruction", axis: "crew", roster: spec.setCrew, reason } };
  }
  if (spec.addCrew?.length || spec.removeCrew?.length) {
    return {
      axis: "crew",
      instruction: { intent: "instruction", axis: "crew", add: spec.addCrew, remove: spec.removeCrew, reason },
    };
  }
  if (typeof spec.airborne === "number" && Number.isFinite(spec.airborne)) {
    return { axis: "airborne", instruction: { intent: "instruction", axis: "airborne", airborneMinutes: spec.airborne, reason } };
  }
  if (spec.reject) {
    return { axis: "day", instruction: { intent: "instruction", axis: "day", decision: "rejected", reason } };
  }
  if (spec.accept) {
    return { axis: "day", instruction: { intent: "instruction", axis: "day", decision: "accepted_exception", reason } };
  }
  return null;
}
