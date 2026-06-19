/**
 * Committed record of questions the bot has asked (S5) and their lifecycle, so it
 * asks each gap at most ONCE and S6 can attach the answer. One file per period,
 * reports/asks/<periodKey>.json, keyed by `${gapType}:${date}`.
 *
 * State machine per (gapType, date):
 *   (absent = OPEN) → ASKED → ANSWERED → RESOLVED | ESCALATED
 *
 * NOT server-only: fs-only, no secret (same precedent as lib/reports.ts). The
 * merge/transition logic is pure; writes are atomic (temp + rename).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { periodKey, type Period } from "./period";
import type { GapType } from "./askGaps";

export type AskState = "ASKED" | "ANSWERED" | "RESOLVED" | "ESCALATED";

export interface AskRecord {
  gapType: GapType;
  date: string;          // YYYY-MM-DD flight day
  channel: string;       // tracked channel NAME the question was posted to
  question: string;      // exact text posted
  state: AskState;
  askedTs: string;       // Slack ts of the bot's question (thread root for replies)
  askedAt: string;       // ISO
  /** Optional outcome note from S6 (the classified answer). */
  note?: string;
}

/** key (`${gapType}:${date}`) → record. */
export type AskLog = Record<string, AskRecord>;

export interface AsksOpts {
  baseDir?: string;
}

export function defaultBaseDir(): string {
  return join(process.cwd(), "reports");
}

function logPath(period: Period, opts?: AsksOpts): string {
  return join(opts?.baseDir ?? defaultBaseDir(), "asks", `${periodKey(period)}.json`);
}

export function readAsks(period: Period, opts?: AsksOpts): AskLog {
  let raw: string;
  try {
    raw = readFileSync(logPath(period, opts), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  return JSON.parse(raw) as AskLog;
}

export function writeAsks(period: Period, log: AskLog, opts?: AsksOpts): void {
  const path = logPath(period, opts);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(log, null, 2));
  renameSync(tmp, path);
}

/** Pure: has this gap already been asked (any state present)? */
export function isAsked(log: AskLog, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(log, key);
}

/** Pure: add/replace a record by key, returning a new log (no mutation). */
export function recordAsk(log: AskLog, key: string, record: AskRecord): AskLog {
  return { ...log, [key]: record };
}

/** Pure: transition an existing record's state (+ optional note); no-op if absent. */
export function setAskState(log: AskLog, key: string, state: AskState, note?: string): AskLog {
  const existing = log[key];
  if (!existing) return log;
  return { ...log, [key]: { ...existing, state, ...(note !== undefined && { note }) } };
}
