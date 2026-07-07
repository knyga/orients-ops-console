/**
 * Calendar tool for the agent loop: calendar_create_event resolves into a
 * confirm-first Proposal (the loop never writes). Attendees resolve through
 * the lib/people.ts roster (email field), a Slack-profile email fallback (lib/attendeesLive.ts), or raw emails — ANY unresolved
 * attendee blocks the proposal (a meeting missing the right people is
 * useless), unlike jira_create's propose-unassigned fallback. Times the model
 * supplies are validated here, so the echo always shows the resolved absolute
 * Kyiv time and a model slip (past date, end before start) is caught before
 * the confirmation question, not on the calendar.
 *
 * Reachable only under server-only conditions (via lib/proposalExecutor →
 * lib/googleCalendar). Needs GOOGLE_SERVICE_ACCOUNT_KEY + GOOGLE_CALENDAR_ORGANIZER
 * at apply time; propose renders without them.
 */
import { resolveAttendeesLive } from "@/lib/attendeesLive";
import { validateEventTimes, renderProposalUk } from "@/lib/calendarEvent";
import { applyProposal } from "@/lib/proposalExecutor";
import type { Proposal, ProposeContext, Tool } from "./types";

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`Missing required "${key}".`);
  return v.trim();
}

export async function calendarCreateProposal(
  args: Record<string, unknown>,
  ctx?: ProposeContext,
): Promise<Proposal> {
  const title = str(args, "title");
  const startIso = str(args, "startIso");
  const endIso = str(args, "endIso");
  const queries = Array.isArray(args.attendees) ? (args.attendees as unknown[]).map(String) : [];

  const times = validateEventTimes(startIso, endIso);
  if (!times.ok) throw new Error(times.problem);
  const resolved = await resolveAttendeesLive(queries);
  if (!resolved.ok) throw new Error(resolved.problems.join(" "));

  const desc = typeof args.description === "string" ? args.description.trim() : "";
  const description = [desc, ctx?.sourceUrl ? `Slack: ${ctx.sourceUrl}` : ""].filter(Boolean).join("\n\n");
  const organizer = process.env.GOOGLE_CALENDAR_ORGANIZER ?? "(GOOGLE_CALENDAR_ORGANIZER не налаштовано)";

  const params = {
    title,
    description,
    startIso,
    endIso,
    attendeeEmails: resolved.attendees.map((a) => a.email),
    requestId: crypto.randomUUID(),
  };
  return {
    kind: "calendar_create_event",
    params,
    echoUk: renderProposalUk({
      title,
      startMs: times.startMs,
      endMs: times.endMs,
      attendees: resolved.attendees,
      organizer,
      description: description || undefined,
    }),
    apply: () => applyProposal("calendar_create_event", params),
  };
}

export const calendarTools: Tool[] = [
  {
    name: "calendar_create_event",
    description:
      "Create a Google Calendar meeting with a Google Meet link and real invites to attendees. " +
      "Convert relative phrases («завтра о 15:00») into concrete Europe/Kyiv ISO datetimes " +
      "(e.g. 2026-07-08T15:00 — no offset needed) using today's date from the system prompt. " +
      "When the user gave no duration, default to 30 minutes (endIso = startIso + 30 min). " +
      "attendees are team-roster names («Тарас», «Влад») or raw email addresses.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Meeting title." },
        startIso: { type: "string", description: "Start, Europe/Kyiv ISO, e.g. 2026-07-08T15:00." },
        endIso: { type: "string", description: "End, Europe/Kyiv ISO. Default: start + 30 minutes." },
        attendees: { type: "array", items: { type: "string" }, description: "Roster names or emails." },
        description: { type: "string", description: "Optional agenda/description." },
      },
      required: ["title", "startIso", "endIso", "attendees"],
    },
    kind: "write",
    propose: calendarCreateProposal,
  },
];
