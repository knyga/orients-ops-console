/** Pure CLI helpers for `who`: arg parsing, period defaulting, table rendering. */
import type { Period } from "../lib/period";
import type { PersonView, UnlinkedReport } from "../lib/who";

export interface WhoArgs { person?: string; start?: string; end?: string; format?: string; unlinked: boolean }

export function parseArgs(argv: string[]): WhoArgs {
  const args: WhoArgs = { unlinked: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--unlinked") args.unlinked = true;
    else if (a === "--person") args.person = argv[++i];
    else if (a === "--start") args.start = argv[++i];
    else if (a === "--end") args.end = argv[++i];
    else if (a === "--format") args.format = argv[++i];
  }
  return args;
}

/** End-of-month day for the month containing `today` (YYYY-MM-DD). */
function monthBounds(today: string): Period {
  const [y, m] = today.split("-").map(Number);
  const start = `${today.slice(0, 7)}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based → day 0 of next month
  const end = `${today.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`;
  return { start, end };
}

export function resolvePeriod(args: WhoArgs, today: string): Period {
  if (args.start && args.end) return { start: args.start, end: args.end };
  return monthBounds(today);
}

export function formatTable(view: PersonView): string {
  const lines: string[] = [];
  lines.push(`PERSON: ${view.person.name} (${view.person.role})`);
  lines.push(`PERIOD: ${view.period.start} .. ${view.period.end}`);
  lines.push("── Slack timeline ──");
  if (view.timeline.length === 0) lines.push("  (no messages)");
  for (const t of view.timeline) {
    lines.push(`  ${t.isoTime.slice(0, 16).replace("T", " ")}  #${t.channel}  ${t.text.replace(/\s+/g, " ").slice(0, 80)}`);
  }
  lines.push("── Summary ──");
  if (view.summary.jira) lines.push(`  jira:   ${view.summary.jira.count} issues, ${view.summary.jira.points} pts  [${view.summary.jira.issueKeys.join(", ")}]`);
  if (view.summary.github) {
    const g = view.summary.github;
    lines.push(`  github: ${g.commits} commits, +${g.additions} -${g.deletions}, ${g.prsOpened} PRs opened / ${g.prsMerged} merged`);
  }
  if (view.summary.field) {
    const f = view.summary.field;
    lines.push(`  field:  ${f.trips} trips, ${f.flightDays} flight days, ${f.flightMinutes} min, ₴${f.netUah}`);
  }
  return lines.join("\n");
}

export function formatUnlinkedTable(report: UnlinkedReport): string {
  const lines = ["UNLINKED IDENTITIES (claimed by no person):"];
  const section = (label: string, xs: string[]) => { for (const x of xs) lines.push(`  ${label}: ${x}`); };
  section("slack ", report.slack);
  section("jira  ", report.jira);
  section("github", report.github);
  section("roster", report.roster);
  if (lines.length === 1) lines.push("  (none — every identity in the data is registered)");
  return lines.join("\n");
}
