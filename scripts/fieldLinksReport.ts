/** Pure arg parsing + table rendering for `npm run field-links`. */
import type { DayNodes, RelinkEdit } from "../lib/dayLinks";

export interface LinksArgs {
  start?: string;
  end?: string;
  channel?: string;
  publish: boolean;
  /** true = --zvit-reply, false = --no-zvit-reply, null = not given. */
  zvitReply: boolean | null;
  format?: "table";
}

export function parseLinksArgs(argv: string[]): LinksArgs {
  const out: LinksArgs = { publish: false, zvitReply: null };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === "--start") { out.start = argv[i + 1]; i += 1; }
    else if (f === "--end") { out.end = argv[i + 1]; i += 1; }
    else if (f === "--channel") { out.channel = argv[i + 1]; i += 1; }
    else if (f === "--publish") out.publish = true;
    else if (f === "--zvit-reply") out.zvitReply = true;
    else if (f === "--no-zvit-reply") out.zvitReply = false;
    else if (f === "--format") { if (argv[i + 1] === "table") out.format = "table"; i += 1; }
    else throw new Error(`Unknown flag ${f}`);
  }
  return out;
}

const RECENT_DAYS = 14;

/** Backfills of old months must not bump every Звіт thread with a new reply:
 *  an explicit flag wins; otherwise only a period ending within the last 14
 *  days posts new Звіт-thread replies (edits are always allowed). */
export function resolveZvitReply(flag: boolean | null, period: { start: string; end: string }, today: string): boolean {
  if (flag !== null) return flag;
  const ageDays = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${period.end}T00:00:00Z`)) / 86_400_000;
  return ageDays <= RECENT_DAYS;
}

export function renderLinksTable(days: { date: string; nodes: DayNodes; edits: RelinkEdit[] }[]): string {
  const mark = (v: unknown) => (v ? "✓" : "–");
  const lines: string[] = [];
  for (const d of days) {
    lines.push(`${d.date}  дрони ${mark(d.nodes.reminderTs)}  підсумок ${mark(d.nodes.summaryTs)}  edits: ${d.edits.length}`);
    d.nodes.reports.forEach((r, i) => {
      lines.push(`    звіт ${i + 1}  вердикт ${mark(r.verdictTs)}  бонуси ${mark(r.bonusTs)}  🔗-звіт ${mark(r.zvitReplyTs)}`);
    });
    for (const e of d.edits) lines.push(`    ${e.op.padEnd(4)}  ${e.key}`);
  }
  return lines.length ? lines.join("\n") : "(no days)";
}
