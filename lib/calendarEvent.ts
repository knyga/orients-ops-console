/**
 * Pure calendar-event shaping: time validation, the exact Google Calendar API
 * request body, and the Ukrainian proposal/confirmation copy. No server-only /
 * node imports — unit-tested; the server-only client (lib/googleCalendar.ts),
 * the agent tool, and the CLI all consume these.
 *
 * Times: an ISO string WITH an explicit offset ("2026-07-08T15:00:00+03:00",
 * "...Z") is that instant; one WITHOUT ("2026-07-08T15:00") is Europe/Kyiv
 * wall time — sent to Google verbatim with timeZone (Google resolves the
 * offset), converted to an epoch here only to validate ordering / past-dating.
 */
import type { ResolvedAttendee } from "./attendees";

export const CALENDAR_TIMEZONE = "Europe/Kyiv";

const NAIVE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const OFFSET_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export interface CalendarEventInput {
  title: string;
  description?: string;
  startIso: string;
  endIso: string;
  attendeeEmails: string[];
  /** Meet conferenceData.createRequest requestId — generated once at propose
   *  time and persisted in the proposal params for determinism across the
   *  confirm round-trip. This dedups only the Meet conference creation; it
   *  does NOT make a retried events.insert idempotent — a retried apply can
   *  still create a duplicate calendar event. */
  requestId: string;
}

function withSeconds(naiveIso: string): string {
  return naiveIso.length === 16 ? `${naiveIso}:00` : naiveIso;
}

/** Offset of `tz` at the given instant, in ms (UTC+3 → +3h). */
function tzOffsetMs(tz: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const p = Object.fromEntries(dtf.formatToParts(at).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - at.getTime();
}

/** Epoch ms for an offset ISO (verbatim) or a naive ISO (Kyiv wall time); null if unparseable. */
export function isoToEpochMs(iso: string): number | null {
  if (OFFSET_ISO.test(iso)) {
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? null : ms;
  }
  if (!NAIVE_ISO.test(iso)) return null;
  const utcGuess = Date.parse(`${withSeconds(iso)}Z`);
  if (Number.isNaN(utcGuess)) return null;
  return utcGuess - tzOffsetMs(CALENDAR_TIMEZONE, new Date(utcGuess));
}

const kyivFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: CALENDAR_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** "YYYY-MM-DD HH:mm" in Kyiv for an epoch ms. */
function kyivStamp(ms: number): string {
  const p = Object.fromEntries(kyivFmt.formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function kyivRange(startMs: number, endMs: number): string {
  const s = kyivStamp(startMs);
  const e = kyivStamp(endMs);
  return s.slice(0, 10) === e.slice(0, 10) ? `${s}–${e.slice(11)}` : `${s} — ${e}`;
}

const PAST_GRACE_MS = 5 * 60_000;

export function validateEventTimes(
  startIso: string,
  endIso: string,
  now: Date = new Date(),
): { ok: true; startMs: number; endMs: number } | { ok: false; problem: string } {
  const startMs = isoToEpochMs(startIso);
  if (startMs === null) {
    return { ok: false, problem: `Не можу розібрати час початку «${startIso}» (очікую ISO, напр. 2026-07-08T15:00).` };
  }
  const endMs = isoToEpochMs(endIso);
  if (endMs === null) {
    return { ok: false, problem: `Не можу розібрати час завершення «${endIso}» (очікую ISO, напр. 2026-07-08T15:30).` };
  }
  if (endMs <= startMs) return { ok: false, problem: "Завершення зустрічі має бути пізніше за початок." };
  if (startMs < now.getTime() - PAST_GRACE_MS) {
    return { ok: false, problem: `Початок ${kyivStamp(startMs)} (Київ) уже в минулому — уточни дату.` };
  }
  return { ok: true, startMs, endMs };
}

/** start + N minutes, preserving the input's flavor: naive stays naive (wall-time
 *  arithmetic, what a human means by «15:00 + 30 хв»), offset forms go via the
 *  instant. Null if start is unparseable. */
export function addMinutesIso(startIso: string, minutes: number): string | null {
  if (NAIVE_ISO.test(startIso)) {
    const ms = Date.parse(`${withSeconds(startIso)}Z`) + minutes * 60_000;
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  const ms = isoToEpochMs(startIso);
  if (ms === null) return null;
  return new Date(ms + minutes * 60_000).toISOString();
}

function timeField(iso: string): { dateTime: string; timeZone: string } {
  return { dateTime: NAIVE_ISO.test(iso) ? withSeconds(iso) : iso, timeZone: CALENDAR_TIMEZONE };
}

/** The exact Calendar API insert body (attendees + a Meet conference request). */
export function buildEventBody(input: CalendarEventInput): Record<string, unknown> {
  return {
    summary: input.title,
    ...(input.description ? { description: input.description } : {}),
    start: timeField(input.startIso),
    end: timeField(input.endIso),
    attendees: input.attendeeEmails.map((email) => ({ email })),
    conferenceData: {
      createRequest: { requestId: input.requestId, conferenceSolutionKey: { type: "hangoutsMeet" } },
    },
  };
}

export function renderProposalUk(r: {
  title: string;
  startMs: number;
  endMs: number;
  attendees: ResolvedAttendee[];
  organizer: string;
  description?: string;
}): string {
  const who = r.attendees
    .map((a) => (a.name === a.email ? a.email : `${a.name} (${a.email})`))
    .join(", ");
  const lines = [
    `📅 Створю зустріч «${r.title}»`,
    `Коли: ${kyivRange(r.startMs, r.endMs)} (Київ)`,
    `Учасники: ${who}`,
    `Організатор: ${r.organizer}`,
  ];
  if (r.description) lines.push(`Опис: ${r.description}`);
  lines.push("Google Meet: так", "Створити і розіслати запрошення? (так/ні)");
  return lines.join("\n");
}

export function renderAppliedUk(created: { htmlLink: string; meetLink?: string }): string {
  const lines = ["✅ Зустріч створено, запрошення розіслано."];
  if (created.meetLink) lines.push(`Google Meet: ${created.meetLink}`);
  lines.push(`Календар: ${created.htmlLink}`);
  return lines.join("\n");
}
