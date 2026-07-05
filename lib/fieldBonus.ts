/**
 * Pure field-bonus calculator. Trip counts iff the day's per-flight-day
 * **verdict** is ACCEPTED or ACCEPTED_EXCEPTION — the unified qualification
 * gate lives in `fieldDayVerdict.ts` (deploy >= 3h, video >= max(2min, 50% of
 * airborne), a drone-count report, a #datasets notice); this module is money
 * math only. Adds early (arrival <= 12:30) and weekend (Sat/Sun) bonuses, then
 * the drone-loss multiplier per flight group over 12 consecutive trips, and
 * the team-wide >3-loss cutoff. No DB/Next imports — unit-tested in isolation.
 */
import type { Period } from "./period";
import { applyRosterCorrection, correctionForReport, type RosterCorrection } from "./rosterCorrection";
import { MIN_DEPLOY_MIN, MIN_VIDEO_MIN, reportKey, type VerdictStatus } from "./fieldDayVerdict";

export const TRIP = 700;
export const EARLY = 200;
export const WEEKEND = 300;
export { MIN_DEPLOY_MIN, MIN_VIDEO_MIN };
/** Round raw video minutes to 1 decimal — the single source of the video-gate value, used by both the calculator and the orchestration so their gate tests can't drift. */
export function roundVideoMin(raw: number): number { return Math.round(raw * 10) / 10; }
export const EARLY_CUTOFF_MIN = 12 * 60 + 30; // 12:30
export const LOSS_WINDOW = 12;
export const TEAM_LOSS_CUTOFF = 3;

export interface LossRecord { date: string; found: boolean; note: string }

/** One flight day, already qualified by the verdict — the calculator's only input shape. */
export interface QualifiedDay {
  date: string;
  /** Звіт message ts — the report's identity; null = synthetic no-Звіт row or legacy. */
  reportTs: string | null;
  /** How many reports this flight day has (>1 = multi-trip day). */
  reportCount: number;
  status: VerdictStatus;
  roster: string[];
  unknownInitials: string[];
  deployMin: number | null;
  videoMin: number;
  start: string | null; // Звіт arrival "HH:MM" for the early bonus
  reasons: string[];
  flew: boolean; // pending money is only at stake when the day flew
}
export interface PendingDay { date: string; reportTs: string | null; roster: string[]; status: VerdictStatus; reasons: string[]; amountAtStake: number }
export interface DayBonus {
  date: string; reportTs: string | null; reportCount: number; roster: string[]; deployMin: number | null; videoMin: number;
  counted: boolean; early: boolean; weekend: boolean; reason: string; status: VerdictStatus;
  /**
   * The rules pot is for a 2-person crew: with >2 bonus-counted people the pot
   * is split among everyone — each person's day amount is scaled by
   * min(2, paidN) / paidN. Optional: committed reports predating the split
   * rule lack it; consumers must default to 1.
   */
  splitFactor?: number;
  /** Bonus-counted crew (roster minus eligibility exclusions). Optional on old committed reports; default to `roster`. */
  paidRoster?: string[];
}
export interface PersonBonus { name: string; trips: number; early: number; weekend: number; gross: number; penaltyPct: number; net: number }
export interface Penalty { group: string[]; lossesInWindow: number; pct: number; reason: string }
export interface Flag { kind: "unknown_initial" | "qualifying_unrecorded" | "counted_no_video" | "no_drone_count"; date: string; detail: string }
export interface BonusReport { period: Period; days: DayBonus[]; people: PersonBonus[]; penalties: Penalty[]; teamZeroed: boolean; flags: Flag[]; total: number; voidedDays: { date: string; reportTs: string | null; roster: string[]; reason: string }[]; pendingDays: PendingDay[] }

const TZ = "Europe/Kyiv";
function isWeekend(date: string): boolean {
  const wd = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: TZ }).format(new Date(`${date}T12:00:00Z`));
  return wd === "Sat" || wd === "Sun";
}
function startMin(start: string | null): number | null {
  if (!start) return null;
  const [h, m] = start.split(":").map(Number);
  return h * 60 + m;
}

export function computeBonuses(input: {
  period: Period;
  days: QualifiedDay[];
  losses: LossRecord[];
  corrections?: RosterCorrection[];
}): BonusReport {
  const { period, days: qualified, losses, corrections = [] } = input;
  const flags: Flag[] = [];
  const days: DayBonus[] = [];
  const pendingDays: PendingDay[] = [];

  for (const q of qualified) {
    for (const u of q.unknownInitials) flags.push({ kind: "unknown_initial", date: q.date, detail: u });
    const counted = q.status === "ACCEPTED" || q.status === "ACCEPTED_EXCEPTION";
    const sm = startMin(q.start);
    const earlyEligible = sm != null && sm <= EARLY_CUTOFF_MIN;
    const early = counted && earlyEligible;
    const weekend = counted && isWeekend(q.date);
    const correction = correctionForReport(corrections, q.date, q.reportTs, q.reportCount);
    const eff = applyRosterCorrection(q.roster, counted, correction);
    const paidRoster = eff.perPerson.filter((p) => p.counted).map((p) => p.name);
    const splitFactor = paidRoster.length > 2 ? 2 / paidRoster.length : 1;
    const reason = counted ? "counted" : q.reasons.join("; ") || q.status;
    days.push({ date: q.date, reportTs: q.reportTs, reportCount: q.reportCount, roster: eff.roster, deployMin: q.deployMin, videoMin: q.videoMin, counted, early, weekend, reason, status: q.status, splitFactor, paidRoster });
    if ((q.status === "PENDING" || q.status === "NEEDS_REVIEW") && q.flew) {
      const perPerson = TRIP + (earlyEligible ? EARLY : 0) + (isWeekend(q.date) ? WEEKEND : 0);
      pendingDays.push({ date: q.date, reportTs: q.reportTs, roster: eff.roster, status: q.status, reasons: q.reasons, amountAtStake: perPerson * Math.min(2, eff.roster.length) });
    }
  }

  // Per-person tallies — honour per-person eligibility overrides. `amount` is
  // the exact (unrounded) sum of per-day shares; rounding happens once per
  // person at period level so split fractions don't accumulate drift.
  const tally = new Map<string, { trips: number; early: number; weekend: number; amount: number; dates: string[] }>();
  for (const d of days) {
    const correction = correctionForReport(corrections, d.date, d.reportTs, d.reportCount ?? 1);
    const eff = applyRosterCorrection(d.roster, d.counted, correction);
    const share = (TRIP + (d.early ? EARLY : 0) + (d.weekend ? WEEKEND : 0)) * (d.splitFactor ?? 1);
    for (const { name, counted } of eff.perPerson) {
      if (!counted) continue;
      const t = tally.get(name) ?? { trips: 0, early: 0, weekend: 0, amount: 0, dates: [] };
      t.trips += 1; if (d.early) t.early += 1; if (d.weekend) t.weekend += 1; t.amount += share; t.dates.push(d.date);
      tally.set(name, t);
    }
  }

  // Flight groups = sets of people who fly together on a counted trip — one
  // trip per ACCEPTED *report*, not per date, so a two-report day contributes
  // two independent trips (each can carry its own loss/penalty exposure).
  const groupKeyByTrip = new Map<string, string>();
  for (const d of days) if (d.counted) groupKeyByTrip.set(reportKey(d.date, d.reportTs), [...d.roster].sort().join("+"));
  const tripsByGroup = new Map<string, string[]>();
  for (const [tripKey, groupKey] of [...groupKeyByTrip.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const arr = tripsByGroup.get(groupKey) ?? []; arr.push(tripKey); tripsByGroup.set(groupKey, arr);
  }
  // Losses are keyed by flight DATE; the upstream extractor (lib/lossExtract)
  // produces at most one loss record per report/date, so deduping by date is
  // intentional and equivalent to counting loss events under that model.
  const lostDates = new Set(losses.filter((l) => !l.found).map((l) => l.date));
  const teamLosses = lostDates.size;
  const teamZeroed = teamLosses > TEAM_LOSS_CUTOFF;

  // Worst penalty per group: max losses inside any window of 12 consecutive trips.
  const penalties: Penalty[] = [];
  const pctByGroup = new Map<string, number>();
  for (const [key, tripKeys] of tripsByGroup.entries()) {
    let worst = 0;
    for (let i = 0; i < tripKeys.length; i++) {
      const window = tripKeys.slice(i, i + LOSS_WINDOW);
      // tripKey is `date` or `date#reportTs` — the date is always the first 10 chars.
      // Losses are per-DATE, so a two-report day on one lost date must count once,
      // not once per report — dedupe to distinct lost dates within the window.
      const inWindow = new Set(window.map((k) => k.slice(0, 10)).filter((d) => lostDates.has(d))).size;
      worst = Math.max(worst, inWindow);
    }
    const pct = worst >= 3 ? 1 : worst >= 2 ? 0.5 : 0;
    if (pct > 0) { pctByGroup.set(key, pct); penalties.push({ group: key.split("+"), lossesInWindow: worst, pct, reason: `${worst} losses within ${LOSS_WINDOW} consecutive trips` }); }
  }

  const people: PersonBonus[] = [...tally.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, t]) => {
    const gross = Math.round(t.amount);
    // A person's penalty = worst penalty among the groups they flew with.
    let penaltyPct = 0;
    for (const [key, pct] of pctByGroup.entries()) if (key.split("+").includes(name)) penaltyPct = Math.max(penaltyPct, pct);
    // Net rounds from the exact amount, not the rounded gross — no double rounding.
    const net = teamZeroed ? 0 : Math.round(t.amount * (1 - penaltyPct));
    return { name, trips: t.trips, early: t.early, weekend: t.weekend, gross, penaltyPct, net };
  });

  const total = people.reduce((s, p) => s + p.net, 0);
  const voidedDays = days.filter((d) => d.status === "REJECTED").map((d) => ({ date: d.date, reportTs: d.reportTs, roster: d.roster, reason: d.reason }));
  return { period, days, people, penalties, teamZeroed, flags, total, voidedDays, pendingDays };
}
