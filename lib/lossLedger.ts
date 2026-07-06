/**
 * Pure drone-loss ledger logic: source precedence (an approver `instruction`
 * row permanently outranks `extracted`), the effective per-date loss view, and
 * the team counter. No DB/Next imports — the DB access lives in lib/lossStore.
 * Row identity is (date, reportTs); reportTs "" marks a day-wide instruction
 * (written from a legacy thread with no reportTs) that overrides every report
 * of its date.
 */
export interface LossRow {
  date: string;
  reportTs: string;
  lost: boolean;
  found: boolean;
  note: string;
  source: "extracted" | "instruction";
  crashTextHash: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface EffectiveLoss {
  date: string;
  found: boolean;
  note: string;
}

/** May `incoming` replace `existing` (same key)? Mirrors sheetImportShouldSkip. */
export function upsertWins(existing: LossRow | undefined, incoming: { source: LossRow["source"] }): boolean {
  if (!existing) return true;
  if (incoming.source === "instruction") return true;
  return existing.source !== "instruction";
}

/** The effective loss state for one date's rows: a day-wide instruction wins,
 *  else per-report with instruction-beats-extracted per reportTs. */
function effectiveForDate(dayRows: LossRow[]): { lost: boolean; found: boolean; note: string } | null {
  const dayWide = dayRows.find((r) => r.reportTs === "" && r.source === "instruction");
  if (dayWide) return dayWide.lost ? dayWide : null;
  const byTs = new Map<string, LossRow>();
  for (const r of dayRows) {
    const cur = byTs.get(r.reportTs);
    if (!cur || (r.source === "instruction" && cur.source !== "instruction")) byTs.set(r.reportTs, r);
  }
  const losses = [...byTs.values()].filter((r) => r.lost);
  if (losses.length === 0) return null;
  // The date counts as unrecovered if ANY of its report losses is unrecovered.
  const unrecovered = losses.find((r) => !r.found);
  return unrecovered ?? losses[0];
}

/** One entry per date in the period whose effective state is a loss. */
export function effectiveLosses(rows: LossRow[], period: { start: string; end: string }): EffectiveLoss[] {
  const inWindow = rows.filter((r) => r.date >= period.start && r.date <= period.end);
  const out: EffectiveLoss[] = [];
  for (const date of [...new Set(inWindow.map((r) => r.date))].sort()) {
    const eff = effectiveForDate(inWindow.filter((r) => r.date === date));
    if (eff) out.push({ date, found: eff.found, note: eff.note });
  }
  return out;
}

/** Distinct dates with an unrecovered loss inside the period (the team counter). */
export function unrecoveredLossDates(rows: LossRow[], period: { start: string; end: string }): string[] {
  return effectiveLosses(rows, period)
    .filter((l) => !l.found)
    .map((l) => l.date);
}

/** The loss state a verdict row should render: per-report instruction, then a
 *  day-wide instruction, then the report's own extracted row. */
export function lossForVerdict(
  rows: LossRow[],
  date: string,
  reportTs: string | null,
): { lost: boolean; found: boolean } | undefined {
  const exact = reportTs
    ? rows.find((r) => r.date === date && r.reportTs === reportTs && r.source === "instruction")
    : undefined;
  const dayWide = rows.find((r) => r.date === date && r.reportTs === "" && r.source === "instruction");
  const extracted = reportTs
    ? rows.find((r) => r.date === date && r.reportTs === reportTs && r.source === "extracted")
    : undefined;
  const rec = exact ?? dayWide ?? extracted;
  return rec?.lost ? { lost: true, found: rec.found } : undefined;
}
