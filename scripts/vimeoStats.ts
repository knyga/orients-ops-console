import { aggregateByDay, FIELD_TIMEZONE, videoUploadDate } from "../lib/reconcile";
import type { ReconVideo } from "../lib/reconcile";
// Type-only import: erased at runtime, so it does NOT pull in `server-only`.
import type { VimeoVideo } from "../lib/vimeo";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type OutputFormat = "json" | "table";

export interface ParsedArgs {
  start?: string;
  end?: string;
  format: OutputFormat;
}

export interface Period {
  start: string;
  end: string;
  timezone: string;
}

export interface DayStat {
  date: string;
  videoCount: number;
  recordedMinutes: number;
}

export interface VideoStat {
  date: string;
  minutes: number;
  name: string;
  link: string;
}

export interface VimeoStats {
  period: Period;
  totals: { videoCount: number; recordedMinutes: number };
  byDay: DayStat[];
  videos: VideoStat[];
}

/** Round to one decimal place (minutes are derived from seconds). */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Parse `--start`, `--end`, `--format` from raw CLI args. Unknown flags ignored. */
export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { start: undefined, end: undefined, format: "json" };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--start") { args.start = value; i += 1; }
    else if (flag === "--end") { args.end = value; i += 1; }
    else if (flag === "--format") {
      args.format = value === "table" ? "table" : "json";
      i += 1;
    }
  }
  return args;
}

/** First day of `today`'s month through `today` (both YYYY-MM-DD). */
export function defaultMonthWindow(today: string): { start: string; end: string } {
  return { start: `${today.slice(0, 7)}-01`, end: today };
}

/**
 * Resolve the reporting window: explicit `--start`/`--end` when both present,
 * otherwise the current month. Throws on a malformed explicit bound.
 */
export function resolvePeriod(args: ParsedArgs, today: string): Period {
  let start = args.start;
  let end = args.end;
  if (!start || !end) {
    const window = defaultMonthWindow(today);
    start = start ?? window.start;
    end = end ?? window.end;
  }
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new Error(`Period bounds must be YYYY-MM-DD: start=${start} end=${end}`);
  }
  return { start, end, timezone: FIELD_TIMEZONE };
}

/**
 * Shape fetched videos into deterministic stats. Reuses the unit-tested
 * `aggregateByDay` for the per-day rollup but reports only Vimeo-derived facts —
 * no `ratio`/`status`, since reconciliation needs flight data we don't have here.
 */
export function buildStats(videos: VimeoVideo[], period: Period): VimeoStats {
  const reconVideos: ReconVideo[] = videos.map((v) => ({
    createdTime: v.created_time,
    durationSeconds: v.duration,
  }));

  const byDay: DayStat[] = aggregateByDay(reconVideos, []).map((d) => ({
    date: d.date,
    videoCount: d.videoCount,
    recordedMinutes: round1(d.recordedMinutes),
  }));

  const totalSeconds = videos.reduce((sum, v) => sum + v.duration, 0);

  const videoStats: VideoStat[] = videos
    .map((v) => ({
      date: videoUploadDate(v.created_time),
      minutes: round1(v.duration / 60),
      name: v.name,
      link: v.link,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    period,
    totals: { videoCount: videos.length, recordedMinutes: round1(totalSeconds / 60) },
    byDay,
    videos: videoStats,
  };
}

/** Render stats as a compact human-readable table. */
export function formatTable(stats: VimeoStats): string {
  const { period, totals, byDay } = stats;
  const lines: string[] = [];
  lines.push(`Period: ${period.start} … ${period.end} (${period.timezone})`);
  lines.push("");
  lines.push("Date         Videos   Minutes");
  lines.push("-----------  ------   -------");
  for (const day of byDay) {
    lines.push(
      `${day.date}   ${String(day.videoCount).padStart(6)}   ${String(day.recordedMinutes).padStart(7)}`,
    );
  }
  lines.push("-----------  ------   -------");
  lines.push(
    `TOTAL        ${String(totals.videoCount).padStart(6)}   ${String(totals.recordedMinutes).padStart(7)}`,
  );
  return lines.join("\n");
}
