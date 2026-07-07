/**
 * Live attendee resolution: the pure roster pass (lib/attendees.ts) plus a
 * Slack-profile email fallback for roster people whose email field is unfilled.
 * Roster email always wins; nothing is cached or written back. SERVER-ONLY
 * reachable (imports lib/slack); the CLI runs under --conditions=react-server.
 * Needs the bot's users:read.email scope — without it fetchUserEmail returns
 * null and the proposal blocks loudly, naming both sources.
 */
import {
  resolveAttendeeQuery,
  collectAttendees,
  EMAIL_RE,
  type AttendeeQueryResult,
  type AttendeeResolution,
} from "./attendees";
import { PEOPLE, type Person } from "./people";
import { fetchUserEmail } from "./slack";

export async function resolveAttendeesLive(
  queries: string[],
  people: Person[] = PEOPLE,
): Promise<AttendeeResolution> {
  const pure = queries
    .map((s) => s.trim())
    .filter(Boolean)
    .map((q) => resolveAttendeeQuery(q, people));
  const results: AttendeeQueryResult[] = await Promise.all(
    pure.map(async (r): Promise<AttendeeQueryResult> => {
      if (r.kind !== "needs-email") return r;
      const raw = await fetchUserEmail(r.slackId);
      const email = raw?.trim();
      if (email && EMAIL_RE.test(email)) {
        return { kind: "resolved", attendee: { name: r.name, email, source: "slack" } };
      }
      return {
        kind: "problem",
        problem: `У «${r.name}» немає email ні в реєстрі (lib/people.ts), ні в профілі Slack.`,
      };
    }),
  );
  return collectAttendees(results);
}
