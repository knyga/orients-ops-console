/**
 * Pure CLI shaping for `field-roster`: arg parsing, period resolution, and the
 * replay that turns an approver's classified thread replies into one effective
 * roster correction. No server/Next/fs imports — unit-tested. Names are assumed
 * already alias-resolved by the CLI before they reach decideRosterCorrection.
 */
import type { RosterCorrectionClassification } from "../lib/rosterCorrectionClassifyPrompt";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface Period { start: string; end: string }
export interface RosterArgs { start?: string; end?: string; write: boolean }

export interface ClassifiedRosterReply {
  classification: RosterCorrectionClassification;
  by: string;
  permalink: string;
  ts: string;
}

export interface RosterOutcome {
  roster: string[];
  eligibility: Record<string, "counted" | "not_counted">;
  note: string;
  by: string;
  evidencePermalink: string;
}

export function parseArgs(argv: string[]): RosterArgs {
  const args: RosterArgs = { write: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--start") { args.start = value; i += 1; }
    else if (flag === "--end") { args.end = value; i += 1; }
    else if (flag === "--write") { args.write = true; }
  }
  return args;
}

export function defaultMonthWindow(today: string): Period {
  return { start: `${today.slice(0, 7)}-01`, end: today };
}

export function resolvePeriod(args: RosterArgs, today: string): Period {
  let start = args.start;
  let end = args.end;
  if (!start || !end) ({ start, end } = defaultMonthWindow(today));
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new Error(`Period bounds must be YYYY-MM-DD: start=${start} end=${end}`);
  }
  return { start, end };
}

/**
 * Replay decisive replies (ts order) onto the parsed baseline. set_roster
 * replaces the crew; patch applies add/remove (membership) and counted/notCounted
 * (eligibility). `unclear` is skipped. note/by/evidence come from the LAST
 * decisive reply. Returns null when nothing decisive applies.
 */
export function decideRosterCorrection(
  parsedRoster: string[],
  replies: ClassifiedRosterReply[],
): RosterOutcome | null {
  const decisive = replies
    .filter((r) => r.classification.kind !== "unclear")
    .sort((a, b) => a.ts.localeCompare(b.ts));
  if (decisive.length === 0) return null;

  let roster = [...parsedRoster];
  const eligibility: Record<string, "counted" | "not_counted"> = {};
  const addName = (n: string) => { if (!roster.includes(n)) roster.push(n); };

  for (const r of decisive) {
    const c = r.classification;
    if (c.kind === "set_roster" && c.roster) {
      roster = [...new Set(c.roster)];
      for (const k of Object.keys(eligibility)) if (!roster.includes(k)) delete eligibility[k];
      continue;
    }
    for (const a of c.add ?? []) addName(a);
    for (const rm of c.remove ?? []) { roster = roster.filter((x) => x !== rm); delete eligibility[rm]; }
    for (const n of c.counted ?? []) { eligibility[n] = "counted"; addName(n); }
    for (const n of c.notCounted ?? []) eligibility[n] = "not_counted";
  }

  const last = decisive[decisive.length - 1];
  return { roster, eligibility, note: last.classification.reason, by: last.by, evidencePermalink: last.permalink };
}
