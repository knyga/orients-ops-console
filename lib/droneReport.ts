/** Pure domain helpers for per-person/per-category drone counts parsed from a
 *  #field-qa drone-count report. No server/Next imports; unit-tested. */
import { mentionize } from "./mention";

export interface DroneEntry {
  /** Name as written in the report (person or category), e.g. "Андріан", "15ка". */
  name: string;
  /** true for a person, false for a category ("Демонстраційні", "15ка", ...). */
  isPerson: boolean;
  /** Total units for this entry (multi-item lines summed). */
  count: number;
}

/** Sum entries sharing the same name+isPerson, preserving first-seen order. Pure. */
export function mergeDroneEntries(entries: DroneEntry[]): DroneEntry[] {
  const order: string[] = [];
  const byKey = new Map<string, DroneEntry>();
  for (const e of entries) {
    const key = `${e.isPerson ? "p" : "c"}:${e.name}`;
    const existing = byKey.get(key);
    if (existing) existing.count += e.count;
    else {
      byKey.set(key, { ...e });
      order.push(key);
    }
  }
  return order.map((k) => byKey.get(k)!);
}

export interface DroneTotals {
  peopleTotal: number;
  otherTotal: number;
  grandTotal: number;
}

/** People total, folded category ("other") total, and grand total. Pure. */
export function droneTotals(entries: DroneEntry[]): DroneTotals {
  let peopleTotal = 0;
  let otherTotal = 0;
  for (const e of entries) {
    if (e.isPerson) peopleTotal += e.count;
    else otherTotal += e.count;
  }
  return { peopleTotal, otherTotal, grandTotal: peopleTotal + otherTotal };
}

/** Ordered "<name> <count>" people terms + an optional folded "інші <n>" term.
 *  When `mention` is true, person names render as Slack `<@id>` mentions. */
function droneTerms(merged: DroneEntry[], mention = false): string[] {
  const { otherTotal } = droneTotals(merged);
  const terms = merged
    .filter((e) => e.isPerson)
    .map((e) => `${mention ? mentionize(e.name) : e.name} ${e.count}`);
  if (otherTotal > 0) terms.push(`інші ${otherTotal}`);
  return terms;
}

/**
 * The Ukrainian drone-count line for a verdict message, or null when there are
 * no positive entries. People listed as-written, non-person categories folded
 * into a single "інші <n>" term, grand total in parens:
 *   🛸 Дрони: Андріан 2, Любомир 3, інші 9 (усього 14)
 * Pass `{ mention: true }` on the Slack-post render path to @mention person
 * entries; `formatDroneCsv` and the web page keep the default (plain names).
 */
export function formatDroneLine(
  entries: DroneEntry[],
  opts: { mention?: boolean } = {},
): string | null {
  const merged = mergeDroneEntries(entries).filter((e) => e.count > 0);
  if (merged.length === 0) return null;
  return `🛸 Дрони: ${droneTerms(merged, opts.mention).join(", ")} (усього ${droneTotals(merged).grandTotal})`;
}

/** Same content as formatDroneLine, CSV-friendly: no emoji, "; " separators,
 *  plain "(<total>)". Empty string when there are no positive entries. */
export function formatDroneCsv(entries: DroneEntry[]): string {
  const merged = mergeDroneEntries(entries).filter((e) => e.count > 0);
  if (merged.length === 0) return "";
  return `${droneTerms(merged).join("; ")} (${droneTotals(merged).grandTotal})`;
}
