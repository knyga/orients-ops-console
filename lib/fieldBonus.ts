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
import { applyRosterCorrection, type RosterCorrection } from "./rosterCorrection";
import { MIN_DEPLOY_MIN, MIN_VIDEO_MIN, type VerdictStatus } from "./fieldDayVerdict";

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
  status: VerdictStatus;
  roster: string[];
  unknownInitials: string[];
  deployMin: number | null;
  videoMin: number;
  start: string | null; // Звіт arrival "HH:MM" for the early bonus
  reasons: string[];
  flew: boolean; // pending money is only at stake when the day flew
}
export interface PendingDay { date: string; roster: string[]; status: VerdictStatus; reasons: string[]; amountAtStake: number }
export interface DayBonus { date: string; roster: string[]; deployMin: number | null; videoMin: number; counted: boolean; early: boolean; weekend: boolean; reason: string; status: VerdictStatus }
export interface PersonBonus { name: string; trips: number; early: number; weekend: number; gross: number; penaltyPct: number; net: number }
export interface Penalty { group: string[]; lossesInWindow: number; pct: number; reason: string }
export interface Flag { kind: "unknown_initial" | "qualifying_unrecorded" | "counted_no_video" | "no_drone_count"; date: string; detail: string }
export interface BonusReport { period: Period; days: DayBonus[]; people: PersonBonus[]; penalties: Penalty[]; teamZeroed: boolean; flags: Flag[]; total: number; voidedDays: { date: string; roster: string[]; reason: string }[]; pendingDays: PendingDay[] }

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
  const correctionFor = (date: string) => corrections.find((c) => c.date === date);
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
    const eff = applyRosterCorrection(q.roster, counted, correctionFor(q.date));
    const reason = counted ? "counted" : q.reasons.join("; ") || q.status;
    days.push({ date: q.date, roster: eff.roster, deployMin: q.deployMin, videoMin: q.videoMin, counted, early, weekend, reason, status: q.status });
    if ((q.status === "PENDING" || q.status === "NEEDS_REVIEW") && q.flew) {
      const perPerson = TRIP + (earlyEligible ? EARLY : 0) + (isWeekend(q.date) ? WEEKEND : 0);
      pendingDays.push({ date: q.date, roster: eff.roster, status: q.status, reasons: q.reasons, amountAtStake: perPerson * eff.roster.length });
    }
  }

  // Per-person tallies — honour per-person eligibility overrides.
  const tally = new Map<string, { trips: number; early: number; weekend: number; dates: string[] }>();
  for (const d of days) {
    const eff = applyRosterCorrection(d.roster, d.counted, correctionFor(d.date));
    for (const { name, counted } of eff.perPerson) {
      if (!counted) continue;
      const t = tally.get(name) ?? { trips: 0, early: 0, weekend: 0, dates: [] };
      t.trips += 1; if (d.early) t.early += 1; if (d.weekend) t.weekend += 1; t.dates.push(d.date);
      tally.set(name, t);
    }
  }

  // Flight groups = sets of people who fly together on a counted day.
  const groupKeyByDate = new Map<string, string>();
  for (const d of days) if (d.counted) groupKeyByDate.set(d.date, [...d.roster].sort().join("+"));
  const tripsByGroup = new Map<string, string[]>();
  for (const [date, key] of [...groupKeyByDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const arr = tripsByGroup.get(key) ?? []; arr.push(date); tripsByGroup.set(key, arr);
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
  for (const [key, dates] of tripsByGroup.entries()) {
    let worst = 0;
    for (let i = 0; i < dates.length; i++) {
      const window = dates.slice(i, i + LOSS_WINDOW);
      const inWindow = window.filter((d) => lostDates.has(d)).length;
      worst = Math.max(worst, inWindow);
    }
    const pct = worst >= 3 ? 1 : worst >= 2 ? 0.5 : 0;
    if (pct > 0) { pctByGroup.set(key, pct); penalties.push({ group: key.split("+"), lossesInWindow: worst, pct, reason: `${worst} losses within ${LOSS_WINDOW} consecutive trips` }); }
  }

  const people: PersonBonus[] = [...tally.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, t]) => {
    const gross = TRIP * t.trips + EARLY * t.early + WEEKEND * t.weekend;
    // A person's penalty = worst penalty among the groups they flew with.
    let penaltyPct = 0;
    for (const [key, pct] of pctByGroup.entries()) if (key.split("+").includes(name)) penaltyPct = Math.max(penaltyPct, pct);
    const net = teamZeroed ? 0 : Math.round(gross * (1 - penaltyPct));
    return { name, trips: t.trips, early: t.early, weekend: t.weekend, gross, penaltyPct, net };
  });

  const total = people.reduce((s, p) => s + p.net, 0);
  const voidedDays = days.filter((d) => d.status === "REJECTED").map((d) => ({ date: d.date, roster: d.roster, reason: d.reason }));
  return { period, days, people, penalties, teamZeroed, flags, total, voidedDays, pendingDays };
}
