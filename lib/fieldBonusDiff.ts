/** Compare computed per-person counts to a sheet export (by_people.csv) to surface divergences. */
import type { BonusReport } from "./fieldBonus";

type Counts = { trips: number; early: number; weekend: number };

export function parseSheetTotals(csv: string): Record<string, Counts> {
  // Expects rows: person,trips,early,weekend (a normalized export). Lossy sheets
  // are normalized by hand before passing; this parser is intentionally simple.
  const out: Record<string, Counts> = {};
  for (const line of csv.split("\n").slice(1)) {
    const [name, trips, early, weekend] = line.split(",");
    if (!name) continue;
    out[name.trim()] = { trips: Number(trips), early: Number(early), weekend: Number(weekend) };
  }
  return out;
}

export function diffAgainstSheet(report: BonusReport, sheet: Record<string, Counts>): { name: string; field: string; ours: number; theirs: number }[] {
  const diffs: { name: string; field: string; ours: number; theirs: number }[] = [];
  for (const p of report.people) {
    const s = sheet[p.name];
    if (!s) { diffs.push({ name: p.name, field: "present", ours: 1, theirs: 0 }); continue; }
    for (const f of ["trips", "early", "weekend"] as const) if (p[f] !== s[f]) diffs.push({ name: p.name, field: f, ours: p[f], theirs: s[f] });
  }
  return diffs;
}
