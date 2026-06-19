/**
 * Durable, committed resolutions store — the agent's memory of human-confirmed
 * exceptions (e.g. "2026-06-13 force-majeure, accepted"). Consulted by the verdict
 * so a remembered exception flips NEEDS_REVIEW → ACCEPTED_EXCEPTION. Decisions are
 * auditable and reversible (edit/remove the entry).
 *
 * NOT server-only: fs-only, no secret (same precedent as lib/reports.ts). Stored
 * as a single all-time file reports/resolutions/store.json (exceptions persist
 * across periods, so it is not period-sharded). The apply/merge logic is pure.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DayVerdict } from "./fieldDayVerdict";

export interface Resolution {
  date: string;                     // YYYY-MM-DD flight day
  decision: "accepted_exception";   // S3 scope; S6 may add more
  note: string;
  source: string;                   // permalink or "manual"
  recordedAt: string;               // ISO
}

export interface ResolutionsOpts {
  baseDir?: string;
}

export function defaultBaseDir(): string {
  return join(process.cwd(), "reports");
}

function storePath(opts?: ResolutionsOpts): string {
  return join(opts?.baseDir ?? defaultBaseDir(), "resolutions", "store.json");
}

/** All resolutions (empty when the store is absent). */
export function readResolutions(opts?: ResolutionsOpts): Resolution[] {
  let raw: string;
  try {
    raw = readFileSync(storePath(opts), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return JSON.parse(raw) as Resolution[];
}

/** Overwrite the store atomically (temp + rename), mkdir -p. */
export function writeResolutions(resolutions: Resolution[], opts?: ResolutionsOpts): void {
  const path = storePath(opts);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(resolutions, null, 2));
  renameSync(tmp, path);
}

/** Insert or replace the resolution for its date, preserving the rest. */
export function upsertResolution(resolution: Resolution, opts?: ResolutionsOpts): void {
  const all = readResolutions(opts).filter((r) => r.date !== resolution.date);
  all.push(resolution);
  all.sort((a, b) => a.date.localeCompare(b.date));
  writeResolutions(all, opts);
}

/** The resolution for a flight day, if any. Pure. */
export function resolutionFor(date: string, resolutions: Resolution[]): Resolution | undefined {
  return resolutions.find((r) => r.date === date);
}

/**
 * Apply a remembered exception: a NEEDS_REVIEW verdict with a matching resolution
 * becomes ACCEPTED_EXCEPTION (note appended to reasons). Other statuses untouched.
 * Pure.
 */
export function applyResolution(verdict: DayVerdict, resolutions: Resolution[]): DayVerdict {
  if (verdict.status !== "NEEDS_REVIEW") return verdict;
  const match = resolutionFor(verdict.date, resolutions);
  if (!match) return verdict;
  return {
    ...verdict,
    status: "ACCEPTED_EXCEPTION",
    reasons: [...verdict.reasons, `exception: ${match.note}`],
  };
}
