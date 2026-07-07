/**
 * Pure attendee resolution for calendar meetings: roster names/aliases (via
 * personByQuery) and raw email addresses → Workspace emails. All-or-nothing —
 * a meeting with a silently dropped attendee is worse than a blocked proposal,
 * so ANY unresolved query fails the whole set with a human-readable problem
 * list (Ukrainian: it surfaces verbatim in the agent turn / CLI output).
 * Unlike jira_create's propose-unassigned fallback, unknown names block here.
 */
import { personByQuery, PEOPLE, type Person } from "./people";

export interface ResolvedAttendee {
  name: string;
  email: string;
}

export type AttendeeResolution =
  | { ok: true; attendees: ResolvedAttendee[] }
  | { ok: false; problems: string[] };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function resolveAttendees(
  queries: string[],
  people: Person[] = PEOPLE,
): AttendeeResolution {
  const attendees: ResolvedAttendee[] = [];
  const problems: string[] = [];
  for (const raw of queries) {
    const q = raw.trim();
    if (!q) continue;
    if (q.includes("@")) {
      if (EMAIL_RE.test(q)) attendees.push({ name: q, email: q });
      else problems.push(`«${q}» не схоже на email.`);
      continue;
    }
    const r = personByQuery(q, people);
    if ("unknown" in r) {
      problems.push(`«${q}» не знайдено в реєстрі (lib/people.ts).`);
      continue;
    }
    if ("ambiguous" in r) {
      problems.push(`«${q}» неоднозначно: ${r.ambiguous.map((p) => p.name).join(", ")}. Уточни, кого саме.`);
      continue;
    }
    if (!r.person.email) {
      problems.push(`У «${r.person.name}» немає email у реєстрі (lib/people.ts) — додай поле email.`);
      continue;
    }
    attendees.push({ name: r.person.name, email: r.person.email });
  }
  if (problems.length) return { ok: false, problems };
  const seen = new Set<string>();
  const unique = attendees.filter((a) => {
    const k = a.email.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!unique.length) return { ok: false, problems: ["Не вказано жодного учасника."] };
  return { ok: true, attendees: unique };
}
