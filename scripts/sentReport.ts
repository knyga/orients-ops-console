/**
 * Pure CLI helpers for `npm run sent`: arg parsing, period defaulting, and the
 * human table view. Keeps scripts/sent.ts a thin IO shell (same pattern as the
 * other *Report.ts files).
 */
import type { SentRow, SentSummary } from "../lib/sentLog";

export interface Period {
  start: string;
  end: string;
}

export interface Args {
  start?: string;
  end?: string;
  format: "json" | "table";
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { format: "json" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--start") args.start = argv[++i];
    else if (a === "--end") args.end = argv[++i];
    else if (a === "--format") args.format = argv[++i] === "table" ? "table" : "json";
  }
  return args;
}

export function resolvePeriod(args: Args, today: string): Period {
  return {
    start: args.start ?? `${today.slice(0, 7)}-01`,
    end: args.end ?? today,
  };
}

export function formatTable(rows: SentRow[], summary: SentSummary, period: Period): string {
  const lines: string[] = [];
  lines.push(`Outbound messages  ${period.start} → ${period.end}  (${summary.total})`);
  const byStatus = Object.entries(summary.byStatus)
    .map(([k, v]) => `${k}:${v}`)
    .join("  ");
  if (byStatus) lines.push(`  ${byStatus}`);
  lines.push("");
  for (const r of rows) {
    const when = (r.sentAt ?? r.reservedAt).replace("T", " ").slice(0, 19);
    const text = r.text.replace(/\s+/g, " ").slice(0, 60);
    lines.push(
      `${when}  ${r.status.padEnd(7)} ${r.feature.padEnd(15)} ${r.origin.padEnd(7)} #${r.channel.padEnd(22)} ${text}`,
    );
  }
  return lines.join("\n");
}
