/**
 * Shared artifact store for committed reports — the backbone of the
 * "skill → CLI `--write` → committed reports/<feature>/<period>.{json,csv} →
 * web renders the committed artifact" pattern.
 *
 * Each feature persists TWO sidecars per period: a lossless `.json` (the web's
 * render source, mirroring what `GET /api/<feature>` returns) and a flat `.csv`
 * (a human/spreadsheet record). The web reads JSON; it never writes — committing
 * artifacts is exclusively the CLI's job (`--write`).
 *
 * This module is deliberately NOT `server-only`: it holds no secrets and is
 * imported by both the API routes AND the Node CLIs (where `server-only`'s
 * default export would throw). It still can't reach the browser bundle because
 * `node:fs` isn't available there — reads are forced through API routes / server
 * components. Same precedent as ../lib/githubClient.
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MONTH_RE = /^\d{4}-\d{2}$/;
const DAY = "\\d{4}-\\d{2}-\\d{2}";
const RANGE_RE = new RegExp(`^(${DAY})_(${DAY})$`);

export interface Period {
  start: string;
  end: string;
}

/** Allow tests to redirect the artifact root. */
export interface ReportOpts {
  baseDir?: string;
}

/**
 * Canonical period key shared by every feature and used as the `?period=` URL
 * value. A window inside one calendar month collapses to `YYYY-MM` (the common
 * monthly cadence); anything spanning months keeps both explicit bounds as
 * `YYYY-MM-DD_YYYY-MM-DD`. This is the period-key half of jiraReport's
 * `reportFileName` — that function now delegates here.
 */
export function periodKey(period: Period): string {
  if (period.start.slice(0, 7) === period.end.slice(0, 7)) {
    return period.start.slice(0, 7);
  }
  return `${period.start}_${period.end}`;
}

/**
 * Inverse of `periodKey`. A `YYYY-MM` key expands to the first..last day of that
 * month; a range key returns its two bounds verbatim. Returns null for anything
 * malformed so callers (API routes) can answer 400.
 */
export function parsePeriodKey(key: string): Period | null {
  if (MONTH_RE.test(key)) {
    const [year, month] = key.split("-").map(Number);
    // Day 0 of the next month is the last day of this one (UTC, no DST drift).
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { start: `${key}-01`, end: `${key}-${String(lastDay).padStart(2, "0")}` };
  }
  const range = RANGE_RE.exec(key);
  if (range) {
    return { start: range[1], end: range[2] };
  }
  return null;
}

/** Repo-root `reports/` directory, resolved relative to this file (…/lib). */
export function defaultBaseDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "reports");
}

/** Absolute path to a feature's artifact file for `key` with extension `ext`. */
export function reportPath(
  feature: string,
  key: string,
  ext: "json" | "csv",
  opts?: ReportOpts,
): string {
  return join(opts?.baseDir ?? defaultBaseDir(), feature, `${key}.${ext}`);
}

/**
 * Write a period's JSON + CSV sidecars under reports/<feature>/, creating the
 * directory if needed. Returns the paths written and the period key. Called only
 * by the CLIs (`--write`); the web never calls this.
 */
export function writeReport(
  feature: string,
  period: Period,
  artifacts: { json: string; csv: string },
  opts?: ReportOpts,
): { key: string; jsonPath: string; csvPath: string } {
  const key = periodKey(period);
  const dir = join(opts?.baseDir ?? defaultBaseDir(), feature);
  mkdirSync(dir, { recursive: true });
  const jsonPath = join(dir, `${key}.json`);
  const csvPath = join(dir, `${key}.csv`);
  writeFileSync(jsonPath, artifacts.json);
  writeFileSync(csvPath, artifacts.csv);
  return { key, jsonPath, csvPath };
}

/**
 * Read a committed JSON artifact. Returns null when the file is absent (the
 * caller decides 404 vs a live fallback); a malformed file throws (a real 500).
 */
export function readReportJson<T>(
  feature: string,
  key: string,
  opts?: ReportOpts,
): T | null {
  const path = reportPath(feature, key, "json", opts);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return JSON.parse(raw) as T;
}

/**
 * List the period keys that have a committed JSON artifact for `feature`,
 * newest first. Scans `.json` (the render source), so a feature that only has
 * legacy `.csv` files shows nothing until its JSON is backfilled. A missing
 * directory yields `[]` (never throws).
 */
export function listPeriods(feature: string, opts?: ReportOpts): string[] {
  const dir = join(opts?.baseDir ?? defaultBaseDir(), feature);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort()
    .reverse();
}
