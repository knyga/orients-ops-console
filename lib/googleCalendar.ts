/**
 * Google Calendar write client. SERVER-ONLY.
 *
 * Reuses the Drive service account (GOOGLE_SERVICE_ACCOUNT_KEY, base64 JSON)
 * but with the calendar.events scope and JWT `subject` impersonation of
 * GOOGLE_CALENDAR_ORGANIZER — that is what domain-wide delegation looks like in
 * code: without `subject` the SA acts as itself and attendee invites 403.
 * Requires the one-time Admin-console DWD grant of exactly this scope to the
 * service account's client ID (see the design spec + .env.example).
 *
 * The CLI runs Node with `--conditions=react-server` so the server-only import
 * resolves to its empty module (same as lib/drive.ts / lib/jira.ts).
 */
import "server-only";
import { JWT } from "google-auth-library";
import { buildEventBody, type CalendarEventInput } from "./calendarEvent";

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const EVENTS_URL =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all";

export class CalendarError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CalendarError";
  }
}

export interface CreatedEvent {
  eventId: string;
  htmlLink: string;
  meetLink?: string;
}

let cachedClient: JWT | null = null;

function client(): JWT {
  if (cachedClient) return cachedClient;
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!b64) throw new CalendarError("GOOGLE_SERVICE_ACCOUNT_KEY is not set on the server.");
  const organizer = process.env.GOOGLE_CALENDAR_ORGANIZER;
  if (!organizer) throw new CalendarError("GOOGLE_CALENDAR_ORGANIZER is not set on the server.");
  let key: { client_email: string; private_key: string };
  try {
    key = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch (e) {
    throw new CalendarError(`GOOGLE_SERVICE_ACCOUNT_KEY is not valid base64 JSON: ${(e as Error).message}`);
  }
  cachedClient = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: [SCOPE],
    subject: organizer,
  });
  return cachedClient;
}

/** Insert the event on the impersonated organizer's primary calendar. Real
 *  invites go out here (sendUpdates=all) — callers must be post-confirmation. */
export async function createCalendarEvent(input: CalendarEventInput): Promise<CreatedEvent> {
  const auth = await client().getRequestHeaders(EVENTS_URL);
  const headers = new Headers(auth as HeadersInit);
  headers.set("content-type", "application/json");
  const res = await fetch(EVENTS_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(buildEventBody(input)),
    cache: "no-store",
  });
  if (res.status === 403) {
    const body = await res.text().catch(() => "");
    throw new CalendarError(
      `Calendar повернув 403 — найімовірніше, domain-wide delegation для сервіс-акаунта ще не надано ` +
        `(Admin console → Security → API controls → Domain-wide delegation, scope ${SCOPE}), ` +
        `або GOOGLE_CALENDAR_ORGANIZER не є користувачем Workspace.` +
        (body ? ` Google: ${body.slice(0, 300)}` : ""),
      403,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new CalendarError(
      `Calendar returned ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 300)}` : ""}`,
      res.status,
    );
  }
  const ev = (await res.json()) as { id: string; htmlLink: string; hangoutLink?: string };
  return { eventId: ev.id, htmlLink: ev.htmlLink, ...(ev.hangoutLink ? { meetLink: ev.hangoutLink } : {}) };
}
