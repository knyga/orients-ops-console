/**
 * Pure per-day rolling-bonus derivation + Ukrainian messages. Derives each
 * roster member's provisional day amount from a counted DayBonus using the
 * existing rate constants (no new calculator), and formats the per-person DM.
 * Amounts are PROVISIONAL — they exclude the monthly drone-loss multiplier,
 * which only settles at month-end. No fs/network.
 *
 * Money is DM-only (2026-09-05): the bot never states amounts in the public
 * #field-qa verdict thread — the thread is where approvers' signals get
 * processed, and a «💰 Бонуси за …: разом 1200 грн» reply there was called out
 * as wrong. The old thread breakdown / no-bonus note formatters are gone; the
 * `bonus_notified.thread_ts` column stays for the messages already posted (the
 * cross-links planner still links them).
 * See docs/superpowers/specs/2026-06-28-rolling-field-bonus-design.md.
 */
import { TRIP, EARLY, WEEKEND, type DayBonus } from "./fieldBonus";

export interface PersonAmount {
  name: string;
  base: number;
  early: number;
  weekend: number;
  total: number;
}

const PROVISIONAL = "Це попередній розрахунок за день — остаточна сума залежить від місячного коригування втрат бортів.";
const FINANCE = "Питання щодо виплат — до фінансового оператора (Марина).";

export function dayPersonBonuses(day: DayBonus): PersonAmount[] {
  if (!day.counted) return [];
  // splitFactor/paidRoster are absent on reports committed before the >2-crew
  // split rule — default to full pay for the whole roster.
  const f = day.splitFactor ?? 1;
  const early = Math.round((day.early ? EARLY : 0) * f);
  const weekend = Math.round((day.weekend ? WEEKEND : 0) * f);
  const total = Math.round((TRIP + (day.early ? EARLY : 0) + (day.weekend ? WEEKEND : 0)) * f);
  // base absorbs the rounding remainder so the parts always sum to the total.
  const base = total - early - weekend;
  return (day.paidRoster ?? day.roster).map((name) => ({ name, base, early, weekend, total }));
}


function parts(p: PersonAmount): string {
  const bits = [`база ${p.base}`];
  if (p.early > 0) bits.push(`ранній +${p.early}`);
  if (p.weekend > 0) bits.push(`вихідний +${p.weekend}`);
  return bits.join(", ");
}


export function formatDm(date: string, person: PersonAmount): string {
  return [
    `💰 Твій польовий бонус за ${date}: ${person.total} грн (${parts(person)}).`,
    PROVISIONAL,
    FINANCE,
  ].join("\n");
}

