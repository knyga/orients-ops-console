/**
 * Parse #field-qa "Звіт" reports into structured roster + deployment windows.
 * Pure (no DB/Next). Hardened for the real variances in the mirror: optional
 * "Звіт" keyword, reversed roster/time order, dot-or-colon separators, threads,
 * and a report date in the text that lags the post time.
 */
import { resolveInitial } from "./fieldRoster";

export interface FieldReport {
  flightDate: string;
  roster: string[];
  unknownInitials: string[];
  start: string | null;
  end: string | null;
  deployMin: number | null;
  crashText: string | null;
  permalink: string;
  threadTs: string;
}

const DATE_RE = /(\d{2})\.(\d{2})\.(\d{4})/;
const WINDOW_RE = /(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})/;

const pad = (n: number | string) => String(n).padStart(2, "0");
const toMin = (h: string, m: string) => Number(h) * 60 + Number(m);

export function parseZvit(
  text: string,
  meta: { permalink: string; threadTs: string },
  aliases: Record<string, string> = {},
): FieldReport | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const dm = DATE_RE.exec(lines[0]);
  if (!dm) return null;
  const flightDate = `${dm[3]}-${dm[2]}-${dm[1]}`;

  const rosterLine = lines[1] ?? "";
  const wm = WINDOW_RE.exec(rosterLine);
  let start: string | null = null;
  let end: string | null = null;
  let deployMin: number | null = null;
  const roster: string[] = [];
  const unknownInitials: string[] = [];
  if (wm) {
    start = `${pad(wm[1])}:${wm[2]}`;
    end = `${pad(wm[3])}:${wm[4]}`;
    deployMin = toMin(wm[3], wm[4]) - toMin(wm[1], wm[2]);
    // Roster tokens are everything on the line that is not the time window.
    const names = rosterLine.replace(WINDOW_RE, " ");
    for (const tok of names.split(/[+/,&]/).map((s) => s.trim()).filter((s) => s && !/^\d+$/.test(s))) {
      const r = resolveInitial(tok, aliases);
      if ("name" in r) roster.push(r.name);
      else unknownInitials.push(r.unknown);
    }
  }
  const crashText = lines.slice(2).join("\n") || null;
  return { flightDate, roster, unknownInitials, start, end, deployMin, crashText, permalink: meta.permalink, threadTs: meta.threadTs };
}

export function parseMonth(
  messages: { text: string; permalink: string; thread_ts?: string; ts: string }[],
  aliases: Record<string, string> = {},
): FieldReport[] {
  const byDate = new Map<string, { ts: string; report: FieldReport }>();
  for (const m of messages) {
    const r = parseZvit(m.text ?? "", { permalink: m.permalink, threadTs: m.thread_ts ?? m.ts }, aliases);
    if (!r) continue;
    const prev = byDate.get(r.flightDate);
    if (!prev || m.ts.localeCompare(prev.ts) > 0) byDate.set(r.flightDate, { ts: m.ts, report: r });
  }
  return [...byDate.values()].map((v) => v.report).sort((a, b) => a.flightDate.localeCompare(b.flightDate));
}
