/**
 * Pure CLI shaping for scripts/slack-sync.ts: arg parsing + window/floor math.
 * No server/Next/fs imports — unit-tested, mirrors scripts/policyReport.ts.
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type SyncMode = "init" | "incremental" | "backfill";

export interface SyncArgs {
  mode: SyncMode;
  /** Backfill floor (YYYY-MM-DD); defaults to the first of the current month. */
  since?: string;
  /** Trailing re-fetch window in days for incremental mode. */
  window: number;
  /** Restrict the run to a single tracked channel name. */
  channel?: string;
}

/** Parse the supported args. `init` is a positional; the rest are flags. */
export function parseArgs(argv: string[]): SyncArgs {
  const args: SyncArgs = { mode: "incremental", window: 7 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "init") {
      args.mode = "init";
    } else if (flag === "--backfill") {
      args.mode = "backfill";
    } else if (flag === "--since") {
      args.since = value;
      i += 1;
    } else if (flag === "--window") {
      args.window = Number(value);
      i += 1;
    } else if (flag === "--channel") {
      args.channel = value;
      i += 1;
    }
  }
  if (args.since !== undefined && !DATE_RE.test(args.since)) {
    throw new Error(`--since must be YYYY-MM-DD: ${args.since}`);
  }
  if (!Number.isFinite(args.window) || args.window < 0) {
    throw new Error(`--window must be a non-negative number: ${args.window}`);
  }
  return args;
}

/** First day (YYYY-MM-DD) of the calendar month containing `today`. */
export function firstOfMonth(today: string): string {
  return `${today.slice(0, 7)}-01`;
}

/** ISO timestamp `days` whole days before `iso`. Assumes a UTC ISO input (no DST math). */
export function subtractDaysIso(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() - days * 86_400_000).toISOString();
}
