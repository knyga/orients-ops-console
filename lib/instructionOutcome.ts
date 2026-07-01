/**
 * Pure crew/eligibility composition for a confirm-first instruction. Replays a
 * classified crew/eligibility instruction onto the day's CURRENT effective crew
 * (the baseline) and returns a RosterOutcome for lib/applyRosterCorrection.
 *
 * The baseline is the key fix over scripts/fieldRosterReport.decideRosterCorrection,
 * which replays onto the parsed "Звіт" roster (empty on a no-Звіт day, which would
 * make `patch add` DROP the existing crew). Here the caller passes the effective
 * current crew (parsed from the published verdict's suffix or the stored
 * correction), so `додай Тараса` on a `[Влад]` day yields `[Влад, Тарас]`.
 *
 * Names are assumed already alias-resolved by the caller. No DB/Next imports.
 */
import type { InstructionClassification } from "./instructionClassifyPrompt";
import type { RosterOutcome } from "../scripts/fieldRosterReport";

export function buildRosterOutcome(
  baseline: string[],
  c: InstructionClassification,
  by: string,
  evidencePermalink: string,
): RosterOutcome {
  let roster = c.roster && c.roster.length ? [...new Set(c.roster)] : [...baseline];
  const eligibility: Record<string, "counted" | "not_counted"> = {};
  const add = (n: string) => {
    if (!roster.includes(n)) roster.push(n);
  };
  for (const a of c.add ?? []) add(a);
  for (const r of c.remove ?? []) {
    roster = roster.filter((x) => x !== r);
    delete eligibility[r];
  }
  for (const n of c.counted ?? []) {
    eligibility[n] = "counted";
    add(n);
  }
  for (const n of c.notCounted ?? []) eligibility[n] = "not_counted";
  return { roster, eligibility, note: c.reason, by, evidencePermalink };
}
