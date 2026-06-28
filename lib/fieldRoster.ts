/**
 * Pure roster initial→name resolution for the #field-qa "Звіт" reports.
 * Seed map plus caller-supplied alias overrides (durable aliases live in the DB,
 * passed in by the orchestrator). No DB/Next imports — unit-tested in isolation.
 */
export type RosterResolution = { name: string } | { unknown: string };

/** Initials seen in real reports. "Серж"/"Сер…" is a name fragment, not a letter. */
export const SEED_ALIASES: Record<string, string> = {
  А: "Андріан",
  Л: "Любомир",
  Д: "Данило",
  Т: "Тарас",
  В: "Влад",
  Н: "Надія",
  К: "Констянтин",
  О: "Олександр",
};

export function resolveInitial(token: string, aliases: Record<string, string> = {}): RosterResolution {
  const t = token.trim();
  if (!t) return { unknown: token };
  if (t.toLowerCase().startsWith("сер")) return { name: "Сергій" };
  const map = { ...SEED_ALIASES, ...aliases };
  // Exact token first (multi-letter aliases), then first-letter fallback.
  const hit = map[t] ?? map[t[0].toUpperCase()];
  return hit ? { name: hit } : { unknown: t };
}
