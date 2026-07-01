/**
 * Pure field-bonus calculator. Trip counts iff deployMin >= 180 AND video >= 2min
 * (the real policy gate — NOT the 50%-of-airborne reconcile gate). Adds early
 * (arrival <= 12:30) and weekend (Sat/Sun) bonuses, then the drone-loss
 * multiplier per flight group over 12 consecutive trips, and the team-wide
 * >3-loss cutoff. No DB/Next imports — unit-tested in isolation.
 */
import type { FieldReport } from "./fieldReports";
import type { Period } from "./period";
import { applyRosterCorrection, type RosterCorrection } from "./rosterCorrection";

export const TRIP = 700;
export const EARLY = 200;
export const WEEKEND = 300;
export const MIN_DEPLOY_MIN = 180;
export const MIN_VIDEO_MIN = 2;
/** Round raw video minutes to 1 decimal — the single source of the video-gate value, used by both the calculator and the orchestration so their gate tests can't drift. */
export function roundVideoMin(raw: number): number { return Math.round(raw * 10) / 10; }
export const EARLY_CUTOFF_MIN = 12 * 60 + 30; // 12:30
export const LOSS_WINDOW = 12;
export const TEAM_LOSS_CUTOFF = 3;

export interface LossRecord { date: string; found: boolean; note: string }
export interface DayBonus { date: string; roster: string[]; deployMin: number | null; videoMin: number; counted: boolean; early: boolean; weekend: boolean; reason: string }
export interface PersonBonus { name: string; trips: number; early: number; weekend: number; gross: number; penaltyPct: number; net: number }
export interface Penalty { group: string[]; lossesInWindow: number; pct: number; reason: string }
export interface Flag { kind: "unknown_initial" | "qualifying_unrecorded" | "counted_no_video" | "no_drone_count"; date: string; detail: string }
export interface BonusReport { period: Period; days: DayBonus[]; people: PersonBonus[]; penalties: Penalty[]; teamZeroed: boolean; flags: Flag[]; total: number; voidedDays: { date: string; roster: string[]; reason: string }[] }

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
  reports: FieldReport[];
  videoMinutesByDate: Record<string, number>;
  losses: LossRecord[];
  corrections?: RosterCorrection[];
  droneCountByDate?: Record<string, boolean>;
}): BonusReport {
  const { period, reports, videoMinutesByDate, losses, corrections = [], droneCountByDate } = input;
  const correctionFor = (date: string) => corrections.find((c) => c.date === date);
  const flags: Flag[] = [];
  const days: DayBonus[] = [];

  for (const r of reports) {
    for (const u of r.unknownInitials) flags.push({ kind: "unknown_initial", date: r.flightDate, detail: u });
    const videoMin = roundVideoMin(videoMinutesByDate[r.flightDate] ?? 0);
    const hoursOk = r.deployMin != null && r.deployMin >= MIN_DEPLOY_MIN;
    const videoOk = videoMin >= MIN_VIDEO_MIN;
    const droneCountReported = droneCountByDate == null || droneCountByDate[r.flightDate] === true;
    const counted = hoursOk && videoOk && droneCountReported;
    if (hoursOk && !videoOk) flags.push({ kind: "counted_no_video", date: r.flightDate, detail: `deploy ${r.deployMin}min but video ${videoMin}min < ${MIN_VIDEO_MIN}` });
    if (hoursOk && videoOk && !droneCountReported) flags.push({ kind: "no_drone_count", date: r.flightDate, detail: `deploy ${r.deployMin}min + video ${videoMin}min OK but no drone-count report in #field-qa` });
    const sm = startMin(r.start);
    const early = counted && sm != null && sm <= EARLY_CUTOFF_MIN;
    const weekend = counted && isWeekend(r.flightDate);
    const reason = counted ? "counted" : !hoursOk ? "deploy<3h" : !videoOk ? "video<2min" : "no-drone-count";
    // Effective crew = parsed roster overridden by any approver correction.
    const eff = applyRosterCorrection(r.roster, counted, correctionFor(r.flightDate));
    days.push({ date: r.flightDate, roster: eff.roster, deployMin: r.deployMin, videoMin, counted, early, weekend, reason });
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
  const voidedDays = days.filter((d) => d.reason === "no-drone-count").map((d) => ({ date: d.date, roster: d.roster, reason: d.reason }));
  return { period, days, people, penalties, teamZeroed, flags, total, voidedDays };
}
