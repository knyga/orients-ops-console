/**
 * Pure attendee resolution for calendar meetings: roster names/aliases (via
 * personByQuery) and raw email addresses → Workspace emails. All-or-nothing —
 * a meeting with a silently dropped attendee is worse than a blocked proposal,
 * so ANY unresolved query fails the whole set with a human-readable problem
 * list (Ukrainian: it surfaces verbatim in the agent turn / CLI output).
 * Unlike jira_create's propose-unassigned fallback, unknown names block here.
 * The live Slack-fallback sibling is lib/attendeesLive.ts.
 */
import { personByQuery, PEOPLE, type Person } from "./people";

export interface ResolvedAttendee {
  name: string;
  email: string;
  /** Set when the email came from the person's Slack profile, not the roster —
   *  surfaced in the proposal echo so the human confirms knowing the source. */
  source?: "slack";
}

export type AttendeeResolution =
  | { ok: true; attendees: ResolvedAttendee[] }
  | { ok: false; problems: string[] };

/** One query's outcome. needs-email = roster person found with a slackId but no
 *  email — the live resolver (lib/attendeesLive.ts) can still rescue it; the
 *  pure path treats it as the roster problem. */
export type AttendeeQueryResult =
  | { kind: "resolved"; attendee: ResolvedAttendee }
  | { kind: "needs-email"; name: string; slackId: string }
  | { kind: "problem"; problem: string };

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function noEmailProblem(name: string): string {
  return `У «${name}» немає email у реєстрі (lib/people.ts) — додай поле email.`;
}

/** Resolve ONE non-empty, pre-trimmed query. */
export function resolveAttendeeQuery(query: string, people: Person[] = PEOPLE): AttendeeQueryResult {
  if (query.includes("@")) {
    if (EMAIL_RE.test(query)) return { kind: "resolved", attendee: { name: query, email: query } };
    return { kind: "problem", problem: `«${query}» не схоже на email.` };
  }
  const r = personByQuery(query, people);
  if ("unknown" in r) return { kind: "problem", problem: `«${query}» не знайдено в реєстрі (lib/people.ts).` };
  if ("ambiguous" in r) {
    return {
      kind: "problem",
      problem: `«${query}» неоднозначно: ${r.ambiguous.map((p) => p.name).join(", ")}. Уточни, кого саме.`,
    };
  }
  if (r.person.email) return { kind: "resolved", attendee: { name: r.person.name, email: r.person.email } };
  if (r.person.slackId) return { kind: "needs-email", name: r.person.name, slackId: r.person.slackId };
  return { kind: "problem", problem: noEmailProblem(r.person.name) };
}

/** All-or-nothing collection + case-insensitive email dedup. A needs-email that
 *  reaches this point unrescued becomes the roster problem. */
export function collectAttendees(results: AttendeeQueryResult[]): AttendeeResolution {
  const attendees: ResolvedAttendee[] = [];
  const problems: string[] = [];
  for (const r of results) {
    if (r.kind === "resolved") attendees.push(r.attendee);
    else if (r.kind === "problem") problems.push(r.problem);
    else problems.push(noEmailProblem(r.name));
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

export function resolveAttendees(queries: string[], people: Person[] = PEOPLE): AttendeeResolution {
  const results = queries
    .map((s) => s.trim())
    .filter(Boolean)
    .map((q) => resolveAttendeeQuery(q, people));
  return collectAttendees(results);
}
