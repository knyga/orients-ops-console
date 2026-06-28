/**
 * Pure per-day rolling-bonus derivation + Ukrainian messages. Derives each
 * roster member's provisional day amount from a counted DayBonus using the
 * existing rate constants (no new calculator), and formats the thread breakdown,
 * the per-person DM, and the no-bonus thread note. Amounts are PROVISIONAL — they
 * exclude the monthly drone-loss multiplier, which only settles at month-end.
 * No fs/network. See docs/superpowers/specs/2026-06-28-rolling-field-bonus-design.md.
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
  const early = day.early ? EARLY : 0;
  const weekend = day.weekend ? WEEKEND : 0;
  return day.roster.map((name) => ({ name, base: TRIP, early, weekend, total: TRIP + early + weekend }));
}

export function dayTotal(people: PersonAmount[]): number {
  return people.reduce((s, p) => s + p.total, 0);
}

function parts(p: PersonAmount): string {
  const bits = [`база ${p.base}`];
  if (p.early > 0) bits.push(`ранній +${p.early}`);
  if (p.weekend > 0) bits.push(`вихідний +${p.weekend}`);
  return bits.join(", ");
}

export function formatThreadBreakdown(date: string, people: PersonAmount[]): string {
  const lines = [`💰 Бонуси за ${date} (попередньо): разом ${dayTotal(people)} грн`];
  for (const p of people) lines.push(`• ${p.name} — ${p.total} грн (${parts(p)})`);
  lines.push(PROVISIONAL);
  return lines.join("\n");
}

export function formatDm(date: string, person: PersonAmount): string {
  return [
    `💰 Твій польовий бонус за ${date}: ${person.total} грн (${parts(person)}).`,
    PROVISIONAL,
    FINANCE,
  ].join("\n");
}

export function formatNoBonusNote(date: string, reason: string): string {
  return `ℹ️ Бонус за ${date} не нараховано: ${reason}.`;
}
