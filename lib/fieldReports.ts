/**
 * Parse #field-qa "Звіт" reports into structured roster + deployment windows.
 * Pure (no DB/Next). Hardened for the real variances in the mirror: optional
 * "Звіт" keyword, reversed roster/time order, dot-or-colon separators, threads.
 * Every Звіт message is a distinct report (one message = one report; corrections
 * are Slack edits under the same ts).
 */
import { resolveInitial } from "./fieldRoster";

export interface FieldReport {
  flightDate: string;
  /** Slack ts of the Звіт message — the report's identity and its thread root. */
  reportTs: string;
  roster: string[];
  unknownInitials: string[];
  start: string | null;
  end: string | null;
  deployMin: number | null;
  crashText: string | null;
  permalink: string;
  threadTs: string;
}

// Header date shapes seen in #field-qa (all real): «27.06.2026», «08.08.26»,
// «13.08», «24.08:», «2026.08.26», and a typo'd future year «28.08.2028». The
// yearless/typo cases resolve against the Slack posting date (Kyiv) — a Звіт
// is posted the same day or shortly after the flight, never for a future year.
const DATE_YMD_RE = /(\d{4})\.(\d{2})\.(\d{2})/;
const DATE_DMY_RE = /(\d{2})\.(\d{2})\.(\d{4})/;
// Yearless / two-digit-year dates are ambiguous inside prose (the bot's own
// «🛸 Звіт по дронах за 18.08 …» reminder, «зустріч 19.08»), so they count only
// when the date IS the header line: «Звіт 13.08», «Звіт 24.08:», «08.08.26».
const DATE_DMY2_RE = /^(?:Звіт\s*)?(\d{2})\.(\d{2})\.(\d{2})\s*[:.]?\s*$/i;
const DATE_DM_RE = /^(?:Звіт\s*)?(\d{2})\.(\d{2})\s*[:.]?\s*$/i;

/** Kyiv calendar date (YYYY-MM-DD) a Slack ts was posted on, or null for a bogus ts. */
function postedKyivDate(slackTs: string): string | null {
  const ms = Number(slackTs) * 1000;
  if (!Number.isFinite(ms) || ms < Date.UTC(2000, 0, 1)) return null;
  return new Date(ms).toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
}

export function parseFlightDate(header: string, postedTs: string): string | null {
  const posted = postedKyivDate(postedTs);
  const postedYear = posted ? Number(posted.slice(0, 4)) : null;
  let m: RegExpExecArray | null;
  if ((m = DATE_YMD_RE.exec(header))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = DATE_DMY_RE.exec(header))) {
    let year = Number(m[3]);
    if (postedYear != null && year > postedYear) year = postedYear; // future-year typo
    return `${year}-${m[2]}-${m[1]}`;
  }
  if ((m = DATE_DMY2_RE.exec(header))) return `20${m[3]}-${m[2]}-${m[1]}`;
  if ((m = DATE_DM_RE.exec(header)) && posted && postedYear != null) {
    const sameYear = `${postedYear}-${m[2]}-${m[1]}`;
    // A report can't precede its own posting by much; a January post about
    // «31.12» is last year's flight.
    return sameYear > posted ? `${postedYear - 1}-${m[2]}-${m[1]}` : sameYear;
  }
  return null;
}
const WINDOW_RE = /(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})/;

const pad = (n: number | string) => String(n).padStart(2, "0");
const toMin = (h: string, m: string) => Number(h) * 60 + Number(m);

export function parseZvit(
  text: string,
  meta: { permalink: string; threadTs: string; reportTs: string },
  aliases: Record<string, string> = {},
): FieldReport | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const flightDate = parseFlightDate(lines[0], meta.reportTs);
  if (!flightDate) return null;

  const rosterLine = lines[1] ?? "";
  // The window is usually on the roster line («А+Серж 14:40-17:40»), but some
  // reports put it on its own line below the roster (date / roster / window).
  // Scan from the roster line down and take the first window match.
  let wm: RegExpExecArray | null = null;
  let windowLineIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    const m = WINDOW_RE.exec(lines[i]);
    if (m) {
      wm = m;
      windowLineIndex = i;
      break;
    }
  }
  let start: string | null = null;
  let end: string | null = null;
  let deployMin: number | null = null;
  const roster: string[] = [];
  const unknownInitials: string[] = [];
  if (wm) {
    start = `${pad(wm[1])}:${wm[2]}`;
    end = `${pad(wm[3])}:${wm[4]}`;
    deployMin = toMin(wm[3], wm[4]) - toMin(wm[1], wm[2]);
    // Roster tokens are everything on the roster line that is not the time
    // window (stripping the window is a no-op when it lived on its own line).
    const names = rosterLine.replace(WINDOW_RE, " ");
    for (const tok of names.split(/[+/,&]/).map((s) => s.trim()).filter((s) => s && !/^\d+$/.test(s))) {
      const r = resolveInitial(tok, aliases);
      if ("name" in r) roster.push(r.name);
      else unknownInitials.push(r.unknown);
    }
  }
  // Descriptive text is everything below the roster line, minus the window
  // line when it sits on its own line (so it never leaks into crashText).
  const crashStart = windowLineIndex > 1 ? windowLineIndex + 1 : 2;
  const crashText = lines.slice(crashStart).join("\n") || null;
  return { flightDate, reportTs: meta.reportTs, roster, unknownInitials, start, end, deployMin, crashText, permalink: meta.permalink, threadTs: meta.threadTs };
}

export function parseMonth(
  messages: { text: string; permalink: string; thread_ts?: string; ts: string }[],
  aliases: Record<string, string> = {},
): FieldReport[] {
  const reports: FieldReport[] = [];
  for (const m of messages) {
    const r = parseZvit(m.text ?? "", { permalink: m.permalink, threadTs: m.thread_ts ?? m.ts, reportTs: m.ts }, aliases);
    if (r) reports.push(r);
  }
  return reports.sort(
    (a, b) => a.flightDate.localeCompare(b.flightDate) || a.reportTs.localeCompare(b.reportTs),
  );
}
