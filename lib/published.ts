/**
 * Committed record of which day-verdicts the bot has already posted to Slack, so
 * re-running the publisher never double-posts (idempotency). One file per period,
 * reports/published/<periodKey>.json, keyed by flight date.
 *
 * NOT server-only: fs-only, no secret (same precedent as lib/reports.ts). The
 * merge logic is pure. Mirrors the atomic temp+rename write used elsewhere.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { periodKey, type Period } from "./period";

export interface PublishedEntry {
  date: string;       // YYYY-MM-DD flight day
  channel: string;    // tracked channel NAME the verdict was posted to
  text: string;       // the exact message posted
  postedAt: string;   // ISO
  /** Slack ts of the posted verdict — the thread root approvers reply under. */
  ts: string;
}

/** date → entry. */
export type PublishedLog = Record<string, PublishedEntry>;

export interface PublishedOpts {
  baseDir?: string;
}

export function defaultBaseDir(): string {
  return join(process.cwd(), "reports");
}

function logPath(period: Period, opts?: PublishedOpts): string {
  return join(opts?.baseDir ?? defaultBaseDir(), "published", `${periodKey(period)}.json`);
}

/** The published log for a period (empty object when absent). */
export function readPublished(period: Period, opts?: PublishedOpts): PublishedLog {
  let raw: string;
  try {
    raw = readFileSync(logPath(period, opts), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  return JSON.parse(raw) as PublishedLog;
}

/** Overwrite the published log atomically (temp + rename), mkdir -p. */
export function writePublished(period: Period, log: PublishedLog, opts?: PublishedOpts): void {
  const path = logPath(period, opts);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(log, null, 2));
  renameSync(tmp, path);
}

/** Pure: has this date already been published? */
export function isPublished(log: PublishedLog, date: string): boolean {
  return Object.prototype.hasOwnProperty.call(log, date);
}

/** Pure: add an entry, returning a new log (does not mutate the input). */
export function recordPublished(log: PublishedLog, entry: PublishedEntry): PublishedLog {
  return { ...log, [entry.date]: entry };
}
