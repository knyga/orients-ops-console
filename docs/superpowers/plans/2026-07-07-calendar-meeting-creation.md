# Google Calendar Meeting Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Slack agent (and a deterministic CLI) create Google Calendar meetings with real attendee invites and a Meet link, confirm-first, as a fixed impersonated organizer.

**Architecture:** Reuse the existing Google service account (`GOOGLE_SERVICE_ACCOUNT_KEY`) with domain-wide delegation and JWT `subject` impersonation of `GOOGLE_CALENDAR_ORGANIZER`. Pure shaping libs (`lib/attendees.ts`, `lib/calendarEvent.ts`) + a server-only client (`lib/googleCalendar.ts`) feed one confirm-first agent write tool (`calendar_create_event`) and one dry-run-by-default CLI (`npm run calendar-write`), both applying through the shared `lib/proposalExecutor.ts`.

**Tech Stack:** Next.js 16 / TypeScript strict, `google-auth-library` (already a dependency), Vitest, Google Calendar API v3.

**Spec:** `docs/superpowers/specs/2026-07-07-calendar-meeting-creation-design.md`

## Global Constraints

- Pure libs (`lib/attendees.ts`, `lib/calendarEvent.ts`) must have NO `server-only`/node/React imports; they are unit-tested.
- `lib/googleCalendar.ts` MUST `import "server-only"` (first import) — the token never reaches the browser.
- Scope is exactly `https://www.googleapis.com/auth/calendar.events`; organizer env var is exactly `GOOGLE_CALENDAR_ORGANIZER`; timezone is exactly `Europe/Kyiv`.
- Proposal kind string is exactly `calendar_create_event` everywhere (tool, executor, params round-trip).
- User-facing copy (proposal echo, apply confirmation, 403 guidance) is Ukrainian; internal validation errors follow the codebase's existing style.
- Nothing reaches Google before confirmation; invites (`sendUpdates=all`) go out only at apply.
- CLI is DRY-RUN by default; only `--yes` writes.
- Import alias `@/*` = repo root. Run single test files with `npx vitest run <path>`.
- Commit after every task with the trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: `Person.email` field + attendee resolution (`lib/attendees.ts`)

**Files:**
- Modify: `lib/people.ts` (the `Person` interface, ~line 14–30)
- Create: `lib/attendees.ts`
- Test: `lib/attendees.test.ts`

**Interfaces:**
- Consumes: `personByQuery(q, people)` and `PEOPLE` from `lib/people.ts` (existing).
- Produces: `resolveAttendees(queries: string[], people?: Person[]): AttendeeResolution`, `interface ResolvedAttendee { name: string; email: string }`, `type AttendeeResolution = { ok: true; attendees: ResolvedAttendee[] } | { ok: false; problems: string[] }`. Tasks 2 and 5 rely on these exact names.

- [ ] **Step 1: Add the `email` field to `Person`**

In `lib/people.ts`, inside `interface Person` (after `githubLogin?: string;`), add:

```ts
  /** Workspace email for Google Calendar invites (filled by a human, like every
   *  other field here — never scraped). A person without one cannot be invited
   *  by name; resolveAttendees (lib/attendees.ts) fails their query loudly. */
  email?: string;
```

Do NOT fill emails on the real `PEOPLE` entries — that's a human follow-up (operator prerequisite 3 in the spec).

- [ ] **Step 2: Write the failing test**

Create `lib/attendees.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveAttendees } from "./attendees";
import type { Person } from "./people";

const FIXTURE: Person[] = [
  { name: "Taras Panasiuk", role: "field", email: "taras@getshaman.com", aliases: ["Тарас Панасюк"] },
  { name: "Vlad Bondar", role: "field", aliases: ["Влад"] }, // deliberately no email
  { name: "Andrii One", role: "dev", email: "a1@getshaman.com", aliases: ["Андрій Один"] },
  { name: "Andrii Two", role: "dev", email: "a2@getshaman.com", aliases: ["Андрій Два"] },
];

describe("resolveAttendees", () => {
  it("resolves roster aliases to Workspace emails", () => {
    const r = resolveAttendees(["Тарас"], FIXTURE);
    expect(r).toEqual({ ok: true, attendees: [{ name: "Taras Panasiuk", email: "taras@getshaman.com" }] });
  });

  it("passes raw emails through verbatim", () => {
    const r = resolveAttendees(["ext@example.com"], FIXTURE);
    expect(r).toEqual({ ok: true, attendees: [{ name: "ext@example.com", email: "ext@example.com" }] });
  });

  it("rejects a malformed email-ish token", () => {
    const r = resolveAttendees(["not@an"], FIXTURE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toContain("not@an");
  });

  it("fails loudly on a resolved person without an email, naming them", () => {
    const r = resolveAttendees(["Влад"], FIXTURE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toMatch(/Vlad Bondar.*email/);
  });

  it("lists candidates on an ambiguous name", () => {
    const r = resolveAttendees(["Андрій"], FIXTURE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toMatch(/Andrii One.*Andrii Two/);
  });

  it("fails loudly on an unknown name — never guesses", () => {
    const r = resolveAttendees(["Xyzzy"], FIXTURE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toContain("Xyzzy");
  });

  it("all-or-nothing: one bad query fails the whole set", () => {
    const r = resolveAttendees(["Тарас", "Xyzzy"], FIXTURE);
    expect(r.ok).toBe(false);
  });

  it("an empty attendee list is an error", () => {
    expect(resolveAttendees([], FIXTURE).ok).toBe(false);
    expect(resolveAttendees(["  "], FIXTURE).ok).toBe(false);
  });

  it("dedupes the same person given by name and by email", () => {
    const r = resolveAttendees(["Тарас", "taras@getshaman.com"], FIXTURE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.attendees).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run lib/attendees.test.ts`
Expected: FAIL — `Cannot find module './attendees'` (or equivalent resolve error).

- [ ] **Step 4: Write the implementation**

Create `lib/attendees.ts`:

```ts
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run lib/attendees.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/people.ts lib/attendees.ts lib/attendees.test.ts
git commit -m "feat(calendar): Person.email field + pure attendee resolution

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Pure event shaping (`lib/calendarEvent.ts`)

**Files:**
- Create: `lib/calendarEvent.ts`
- Test: `lib/calendarEvent.test.ts`

**Interfaces:**
- Consumes: `type ResolvedAttendee` from Task 1 (type-only import).
- Produces (Tasks 3–6 rely on these exact signatures):
  - `CALENDAR_TIMEZONE = "Europe/Kyiv"`
  - `interface CalendarEventInput { title: string; description?: string; startIso: string; endIso: string; attendeeEmails: string[]; requestId: string }`
  - `isoToEpochMs(iso: string): number | null`
  - `validateEventTimes(startIso, endIso, now?: Date): { ok: true; startMs: number; endMs: number } | { ok: false; problem: string }`
  - `addMinutesIso(startIso: string, minutes: number): string | null`
  - `buildEventBody(input: CalendarEventInput): Record<string, unknown>`
  - `renderProposalUk(r: { title: string; startMs: number; endMs: number; attendees: ResolvedAttendee[]; organizer: string; description?: string }): string`
  - `renderAppliedUk(created: { htmlLink: string; meetLink?: string }): string`

- [ ] **Step 1: Write the failing test**

Create `lib/calendarEvent.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  isoToEpochMs,
  validateEventTimes,
  addMinutesIso,
  buildEventBody,
  renderProposalUk,
  renderAppliedUk,
} from "./calendarEvent";

describe("isoToEpochMs", () => {
  it("parses an explicit-offset ISO as that instant", () => {
    expect(isoToEpochMs("2026-07-08T15:00:00+03:00")).toBe(Date.parse("2026-07-08T12:00:00Z"));
    expect(isoToEpochMs("2026-07-08T12:00:00Z")).toBe(Date.parse("2026-07-08T12:00:00Z"));
  });
  it("treats a naive ISO as Kyiv wall time (summer = UTC+3)", () => {
    expect(isoToEpochMs("2026-07-08T15:00")).toBe(Date.parse("2026-07-08T12:00:00Z"));
  });
  it("treats a naive ISO as Kyiv wall time (winter = UTC+2)", () => {
    expect(isoToEpochMs("2026-01-15T10:00")).toBe(Date.parse("2026-01-15T08:00:00Z"));
  });
  it("rejects garbage", () => {
    expect(isoToEpochMs("tomorrow 3pm")).toBeNull();
    expect(isoToEpochMs("2026-07-08")).toBeNull();
  });
});

describe("validateEventTimes", () => {
  const now = new Date("2026-07-07T10:00:00Z");
  it("accepts a future start with end after start", () => {
    const r = validateEventTimes("2026-07-08T15:00", "2026-07-08T15:30", now);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.endMs - r.startMs).toBe(30 * 60_000);
  });
  it("rejects end <= start", () => {
    const r = validateEventTimes("2026-07-08T15:00", "2026-07-08T15:00", now);
    expect(r.ok).toBe(false);
  });
  it("rejects a past start (a model slip like a wrong year)", () => {
    const r = validateEventTimes("2025-07-08T15:00", "2025-07-08T15:30", now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain("минулому");
  });
  it("rejects unparseable times with the offending string named", () => {
    const r = validateEventTimes("someday", "2026-07-08T15:30", now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain("someday");
  });
});

describe("addMinutesIso", () => {
  it("adds minutes to a naive ISO as wall time", () => {
    expect(addMinutesIso("2026-07-08T15:00", 30)).toBe("2026-07-08T15:30");
  });
  it("crosses midnight", () => {
    expect(addMinutesIso("2026-07-08T23:45", 30)).toBe("2026-07-09T00:15");
  });
  it("handles an explicit-offset ISO via the instant", () => {
    expect(addMinutesIso("2026-07-08T12:00:00Z", 60)).toBe("2026-07-08T13:00:00.000Z");
  });
  it("returns null on garbage", () => {
    expect(addMinutesIso("nope", 30)).toBeNull();
  });
});

describe("buildEventBody", () => {
  const input = {
    title: "Синк по польотах",
    description: "Порядок денний",
    startIso: "2026-07-08T15:00",
    endIso: "2026-07-08T15:30",
    attendeeEmails: ["a@x.com", "b@x.com"],
    requestId: "req-1",
  };
  it("normalizes naive times to seconds precision with the Kyiv timeZone", () => {
    const body = buildEventBody(input) as Record<string, { dateTime: string; timeZone: string }>;
    expect(body.start).toEqual({ dateTime: "2026-07-08T15:00:00", timeZone: "Europe/Kyiv" });
    expect(body.end).toEqual({ dateTime: "2026-07-08T15:30:00", timeZone: "Europe/Kyiv" });
  });
  it("maps attendees and requests a Meet conference", () => {
    const body = buildEventBody(input) as {
      summary: string;
      attendees: { email: string }[];
      conferenceData: { createRequest: { requestId: string; conferenceSolutionKey: { type: string } } };
    };
    expect(body.summary).toBe("Синк по польотах");
    expect(body.attendees).toEqual([{ email: "a@x.com" }, { email: "b@x.com" }]);
    expect(body.conferenceData.createRequest.requestId).toBe("req-1");
    expect(body.conferenceData.createRequest.conferenceSolutionKey.type).toBe("hangoutsMeet");
  });
  it("omits an empty description", () => {
    const body = buildEventBody({ ...input, description: "" });
    expect("description" in body).toBe(false);
  });
});

describe("renderProposalUk", () => {
  it("shows title, same-day Kyiv range, attendees, organizer, and the confirm question", () => {
    const out = renderProposalUk({
      title: "Синк",
      startMs: Date.parse("2026-07-08T12:00:00Z"), // 15:00 Kyiv summer
      endMs: Date.parse("2026-07-08T12:30:00Z"),
      attendees: [
        { name: "Taras Panasiuk", email: "taras@getshaman.com" },
        { name: "ext@example.com", email: "ext@example.com" },
      ],
      organizer: "bot@getshaman.com",
    });
    expect(out).toContain("«Синк»");
    expect(out).toContain("2026-07-08 15:00–15:30");
    expect(out).toContain("Taras Panasiuk (taras@getshaman.com)");
    expect(out).toContain("ext@example.com");
    expect(out).not.toContain("ext@example.com (ext@example.com)");
    expect(out).toContain("bot@getshaman.com");
    expect(out).toContain("Google Meet: так");
    expect(out).toContain("(так/ні)");
  });
});

describe("renderAppliedUk", () => {
  it("includes the Meet link when present", () => {
    const out = renderAppliedUk({ htmlLink: "https://cal/e", meetLink: "https://meet.google.com/x" });
    expect(out).toContain("✅");
    expect(out).toContain("https://meet.google.com/x");
    expect(out).toContain("https://cal/e");
  });
  it("still confirms without a Meet link", () => {
    const out = renderAppliedUk({ htmlLink: "https://cal/e" });
    expect(out).toContain("https://cal/e");
    expect(out).not.toContain("Meet:");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/calendarEvent.test.ts`
Expected: FAIL — cannot resolve `./calendarEvent`.

- [ ] **Step 3: Write the implementation**

Create `lib/calendarEvent.ts`:

```ts
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
  /** Meet conferenceData requestId — generated once at propose time and
   *  persisted in the proposal params, so a retried apply reuses it. */
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/calendarEvent.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add lib/calendarEvent.ts lib/calendarEvent.test.ts
git commit -m "feat(calendar): pure event shaping — time validation, API body, UA copy

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Server-only Calendar client (`lib/googleCalendar.ts`)

**Files:**
- Create: `lib/googleCalendar.ts`
- Test: `lib/googleCalendar.test.ts`

**Interfaces:**
- Consumes: `buildEventBody`, `type CalendarEventInput` from Task 2; `JWT` from `google-auth-library`.
- Produces: `createCalendarEvent(input: CalendarEventInput): Promise<CreatedEvent>`, `interface CreatedEvent { eventId: string; htmlLink: string; meetLink?: string }`, `class CalendarError extends Error`. Task 4 relies on `createCalendarEvent`.

- [ ] **Step 1: Write the failing test**

Create `lib/googleCalendar.test.ts` (mocks `google-auth-library` so no real signing/network; `vi.resetModules()` clears the module-level client cache between tests):

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const jwtCtor = vi.hoisted(() => vi.fn());
vi.mock("google-auth-library", () => ({
  JWT: class {
    constructor(opts: unknown) {
      jwtCtor(opts);
    }
    async getRequestHeaders() {
      return { Authorization: "Bearer test-token" };
    }
  },
}));

const KEY_B64 = Buffer.from(
  JSON.stringify({ client_email: "sa@proj.iam.gserviceaccount.com", private_key: "k" }),
).toString("base64");

const INPUT = {
  title: "T",
  startIso: "2026-07-08T15:00",
  endIso: "2026-07-08T15:30",
  attendeeEmails: ["a@x.com"],
  requestId: "r1",
};

function okEvent(): Response {
  return new Response(
    JSON.stringify({ id: "ev1", htmlLink: "https://cal/e", hangoutLink: "https://meet.google.com/x" }),
    { status: 200 },
  );
}

beforeEach(() => {
  vi.resetModules();
  jwtCtor.mockClear();
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY = KEY_B64;
  process.env.GOOGLE_CALENDAR_ORGANIZER = "bot@getshaman.com";
});
afterEach(() => vi.restoreAllMocks());

describe("createCalendarEvent", () => {
  it("impersonates the organizer (JWT subject) with the calendar.events scope", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okEvent());
    const { createCalendarEvent } = await import("./googleCalendar");
    await createCalendarEvent(INPUT);
    expect(jwtCtor.mock.calls[0][0]).toMatchObject({
      subject: "bot@getshaman.com",
      scopes: ["https://www.googleapis.com/auth/calendar.events"],
    });
  });

  it("POSTs to primary events with conferenceDataVersion=1 & sendUpdates=all and returns the links", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(okEvent());
    const { createCalendarEvent } = await import("./googleCalendar");
    const created = await createCalendarEvent(INPUT);
    const url = String(f.mock.calls[0][0]);
    expect(url).toContain("/calendars/primary/events");
    expect(url).toContain("conferenceDataVersion=1");
    expect(url).toContain("sendUpdates=all");
    expect(f.mock.calls[0][1]?.method).toBe("POST");
    const body = JSON.parse(String(f.mock.calls[0][1]?.body));
    expect(body.summary).toBe("T");
    expect(body.conferenceData.createRequest.requestId).toBe("r1");
    expect(created).toEqual({ eventId: "ev1", htmlLink: "https://cal/e", meetLink: "https://meet.google.com/x" });
  });

  it("maps 403 to an actionable domain-wide-delegation message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("forbidden", { status: 403 }));
    const { createCalendarEvent } = await import("./googleCalendar");
    await expect(createCalendarEvent(INPUT)).rejects.toThrow(/domain-wide delegation/i);
  });

  it("fails with a config error naming a missing GOOGLE_CALENDAR_ORGANIZER", async () => {
    delete process.env.GOOGLE_CALENDAR_ORGANIZER;
    const { createCalendarEvent } = await import("./googleCalendar");
    await expect(createCalendarEvent(INPUT)).rejects.toThrow(/GOOGLE_CALENDAR_ORGANIZER/);
  });

  it("fails with a config error naming a missing GOOGLE_SERVICE_ACCOUNT_KEY", async () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    const { createCalendarEvent } = await import("./googleCalendar");
    await expect(createCalendarEvent(INPUT)).rejects.toThrow(/GOOGLE_SERVICE_ACCOUNT_KEY/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/googleCalendar.test.ts`
Expected: FAIL — cannot resolve `./googleCalendar`.

- [ ] **Step 3: Write the implementation**

Create `lib/googleCalendar.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/googleCalendar.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/googleCalendar.ts lib/googleCalendar.test.ts
git commit -m "feat(calendar): server-only Calendar client with DWD impersonation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Executor case (`calendar_create_event` in `lib/proposalExecutor.ts`)

**Files:**
- Modify: `lib/proposalExecutor.ts` (ProposalKind union ~line 20; switch ~line 58)
- Modify: `lib/proposalExecutor.test.ts` (add a mock + two tests)

**Interfaces:**
- Consumes: `createCalendarEvent` (Task 3), `renderAppliedUk` (Task 2).
- Produces: `applyProposal("calendar_create_event", params)` where `params = { title, description, startIso, endIso, attendeeEmails, requestId }` — the serialized shape Task 5's proposal persists across the Slack confirm round-trip.

- [ ] **Step 1: Write the failing tests**

In `lib/proposalExecutor.test.ts`, add below the existing `mockFetch` helper (module level, above `describe`):

```ts
vi.mock("@/lib/googleCalendar", () => ({
  createCalendarEvent: vi.fn(async () => ({
    eventId: "ev1",
    htmlLink: "https://calendar.google.com/event?eid=ev1",
    meetLink: "https://meet.google.com/abc-defg-hij",
  })),
}));
```

And add inside the `describe("applyProposal", ...)` block:

```ts
  it("calendar_create_event passes the serialized params to createCalendarEvent and returns the UA confirmation", async () => {
    const { createCalendarEvent } = await import("@/lib/googleCalendar");
    const out = await applyProposal("calendar_create_event", {
      title: "Синк",
      description: "",
      startIso: "2026-07-08T15:00",
      endIso: "2026-07-08T15:30",
      attendeeEmails: ["a@x.com"],
      requestId: "r-1",
    });
    expect(out).toContain("✅");
    expect(out).toContain("https://meet.google.com/abc-defg-hij");
    expect(vi.mocked(createCalendarEvent).mock.calls[0][0]).toMatchObject({
      title: "Синк",
      attendeeEmails: ["a@x.com"],
      requestId: "r-1",
    });
  });

  it("calendar_create_event rejects params missing a required field", async () => {
    await expect(
      applyProposal("calendar_create_event", { title: "X", endIso: "2026-07-08T15:30" }),
    ).rejects.toThrow(/startIso/);
  });
```

Note: `vi.restoreAllMocks()` in the existing `afterEach` restores spies but not module mocks, and `vi.mocked(createCalendarEvent)` accumulates calls across tests — index `[0]` is safe because this is the first calendar test in the file.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run lib/proposalExecutor.test.ts`
Expected: the two new tests FAIL (`Unknown proposal kind: calendar_create_event` / type error); all existing jira tests still PASS.

- [ ] **Step 3: Implement the executor case**

In `lib/proposalExecutor.ts`:

Add to the imports (after the `@/lib/jira` import block):

```ts
import { createCalendarEvent } from "@/lib/googleCalendar";
import { renderAppliedUk } from "@/lib/calendarEvent";
```

Widen the union:

```ts
export type ProposalKind =
  | "jira_create"
  | "jira_comment"
  | "jira_transition"
  | "jira_update"
  | "jira_move_to_sprint"
  | "calendar_create_event";
```

Add the case before `default:`:

```ts
    case "calendar_create_event": {
      const created = await createCalendarEvent({
        title: str(params, "title"),
        description: typeof params.description === "string" ? params.description : "",
        startIso: str(params, "startIso"),
        endIso: str(params, "endIso"),
        attendeeEmails: Array.isArray(params.attendeeEmails) ? (params.attendeeEmails as string[]) : [],
        requestId: str(params, "requestId"),
      });
      return renderAppliedUk(created);
    }
```

Also update the file's top doc comment first line: `perform the Jira write` → `perform the Jira/Calendar write`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/proposalExecutor.test.ts`
Expected: PASS (all, including the pre-existing jira tests).

- [ ] **Step 5: Commit**

```bash
git add lib/proposalExecutor.ts lib/proposalExecutor.test.ts
git commit -m "feat(calendar): calendar_create_event case in the proposal executor

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Agent write tool (`calendar_create_event`) + loop registration

**Files:**
- Create: `lib/agent/tools/calendar.ts`
- Test: `lib/agent/tools/calendar.test.ts`
- Modify: `lib/agent/loop.ts` (imports ~line 15–16, system prompt ~line 31–42, default tools ~line 78)

**Interfaces:**
- Consumes: `resolveAttendees` (Task 1), `validateEventTimes`/`renderProposalUk` (Task 2), `applyProposal` (Task 4), `Proposal`/`ProposeContext`/`Tool` from `lib/agent/tools/types.ts`.
- Produces: `calendarCreateProposal(args, ctx?): Promise<Proposal>` and `calendarTools: Tool[]`. Task 6's CLI imports `calendarCreateProposal`.

- [ ] **Step 1: Write the failing test**

Create `lib/agent/tools/calendar.test.ts` (raw emails avoid depending on registry emails, which are unfilled; far-future dates keep validation deterministic):

```ts
import { describe, it, expect } from "vitest";
import { calendarCreateProposal, calendarTools } from "./calendar";

const ARGS = {
  title: "Синк по польотах",
  startIso: "2099-01-05T15:00",
  endIso: "2099-01-05T15:30",
  attendees: ["a@x.com", "b@x.com"],
};

describe("calendarCreateProposal", () => {
  it("resolves into a confirm-first proposal with serializable params and a UA echo", async () => {
    const p = await calendarCreateProposal({ ...ARGS });
    expect(p.kind).toBe("calendar_create_event");
    expect(p.params).toMatchObject({
      title: "Синк по польотах",
      startIso: "2099-01-05T15:00",
      endIso: "2099-01-05T15:30",
      attendeeEmails: ["a@x.com", "b@x.com"],
    });
    expect(typeof p.params.requestId).toBe("string");
    expect((p.params.requestId as string).length).toBeGreaterThan(8);
    // params must survive a JSON round-trip (the Slack confirm persists them)
    expect(JSON.parse(JSON.stringify(p.params))).toEqual(p.params);
    expect(p.echoUk).toContain("«Синк по польотах»");
    expect(p.echoUk).toContain("2099-01-05 15:00–15:30");
    expect(p.echoUk).toContain("(так/ні)");
  });

  it("appends ctx.sourceUrl to the description deterministically", async () => {
    const p = await calendarCreateProposal({ ...ARGS }, { sourceUrl: "https://orients.slack.com/archives/C1/p1" });
    expect(p.params.description).toContain("Slack: https://orients.slack.com/archives/C1/p1");
    expect(p.echoUk).toContain("Slack: https://orients.slack.com/archives/C1/p1");
  });

  it("blocks the proposal on an unknown attendee (never guesses)", async () => {
    await expect(calendarCreateProposal({ ...ARGS, attendees: ["Xyzzy Nobody"] })).rejects.toThrow(/Xyzzy Nobody/);
  });

  it("blocks the proposal on invalid times", async () => {
    await expect(
      calendarCreateProposal({ ...ARGS, startIso: "2020-01-01T10:00", endIso: "2020-01-01T10:30" }),
    ).rejects.toThrow(/минулому/);
  });

  it("blocks the proposal when required args are missing", async () => {
    await expect(calendarCreateProposal({ startIso: "2099-01-05T15:00" })).rejects.toThrow(/title/);
  });
});

describe("calendarTools", () => {
  it("exposes calendar_create_event as a write tool with propose", () => {
    expect(calendarTools).toHaveLength(1);
    const t = calendarTools[0];
    expect(t.name).toBe("calendar_create_event");
    expect(t.kind).toBe("write");
    expect(typeof t.propose).toBe("function");
    expect(t.run).toBeUndefined();
    const schema = t.inputSchema as { required: string[] };
    expect(schema.required).toEqual(["title", "startIso", "endIso", "attendees"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/agent/tools/calendar.test.ts`
Expected: FAIL — cannot resolve `./calendar`.

- [ ] **Step 3: Write the implementation**

Create `lib/agent/tools/calendar.ts`:

```ts
/**
 * Calendar tool for the agent loop: calendar_create_event resolves into a
 * confirm-first Proposal (the loop never writes). Attendees resolve through
 * the lib/people.ts roster (email field) or raw emails — ANY unresolved
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
import { resolveAttendees } from "@/lib/attendees";
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
  const resolved = resolveAttendees(queries);
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/agent/tools/calendar.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Register the tool in the loop**

In `lib/agent/loop.ts`:

Add after `import { fieldLossTools } from "./tools/fieldLoss";`:

```ts
import { calendarTools } from "./tools/calendar";
```

Change the default tool set (~line 78):

```ts
  const tools = opts.tools ?? [...jiraTools, ...fieldLossTools, ...calendarTools];
```

Add one line to the `systemPrompt` array (after the «Ніколи не пиши…» line):

```ts
  "«Постав/створи зустріч» — це calendar_create_event: перетвори відносну дату в конкретний Europe/Kyiv ISO (напр. 2026-07-08T15:00); без явної тривалості бери 30 хв; учасники — імена з реєстру або email. Це теж запис із підтвердженням.",
```

And extend the capabilities sentence (the second systemPrompt line) — replace:

```ts
  "Ти — асистент інженерної команди Orients у Slack. Ти вмієш шукати і змінювати задачі в Jira через інструменти. Ти також можеш відповідати про втрати дронів за період через інструмент field_loss_status.",
```

with:

```ts
  "Ти — асистент інженерної команди Orients у Slack. Ти вмієш шукати і змінювати задачі в Jira через інструменти. Ти також можеш відповідати про втрати дронів за період через інструмент field_loss_status і створювати зустрічі в Google Calendar через calendar_create_event.",
```

- [ ] **Step 6: Run the agent test suites to catch regressions**

Run: `npx vitest run lib/agent`
Expected: PASS — loop/slackTurn/threadContext/tool tests unaffected (they inject their own `tools`).

- [ ] **Step 7: Commit**

```bash
git add lib/agent/tools/calendar.ts lib/agent/tools/calendar.test.ts lib/agent/loop.ts
git commit -m "feat(agent): calendar_create_event confirm-first write tool

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: CLI (`npm run calendar-write`) + env + docs

**Files:**
- Create: `scripts/calendar-write.ts`
- Modify: `package.json` (scripts block, next to `"jira-write"`)
- Modify: `.env.example` (after the Google Drive block)
- Modify: `CLAUDE.md` (Commands list, after the `jira-write` bullet)

**Interfaces:**
- Consumes: `calendarCreateProposal` (Task 5), `addMinutesIso` (Task 2).
- Produces: the `calendar-write` npm script — the feature's deterministic CLI surface.

- [ ] **Step 1: Write the CLI**

Create `scripts/calendar-write.ts`:

```ts
/**
 * CLI: create a Google Calendar meeting (Meet link + real invites) organized by
 * the impersonated GOOGLE_CALENDAR_ORGANIZER account.
 *
 * Usage:
 *   npm run calendar-write -- create --title "<text>" --start "2026-07-08T15:00" \
 *     [--end "2026-07-08T16:00" | --duration 30] --attendees "Тарас,Влад,x@y.com" \
 *     [--desc "<text>"] [--yes]
 *
 * DRY-RUN by default: prints the resolved plan (absolute Kyiv times, resolved
 * attendee emails, organizer) and touches nothing. `--yes` creates the event and
 * prints the Meet + Calendar links. Attendees resolve via the lib/people.ts
 * roster (email field) or raw emails; unknown names fail loudly. No LLM — the
 * same propose/apply path the agent's calendar_create_event tool uses.
 *
 * Runs only under Node with `--conditions=react-server` (see package.json) so
 * the `server-only` import in ../lib/googleCalendar resolves to its empty
 * module. Needs GOOGLE_SERVICE_ACCOUNT_KEY + GOOGLE_CALENDAR_ORGANIZER (+ the
 * one-time domain-wide-delegation grant) for --yes; dry-run needs no env.
 */
import { calendarCreateProposal } from "../lib/agent/tools/calendar";
import { addMinutesIso } from "../lib/calendarEvent";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  if (process.argv[2] !== "create") {
    console.error(
      'Usage: npm run calendar-write -- create --title "<text>" --start "2026-07-08T15:00" ' +
        '[--end "..." | --duration 30] --attendees "Тарас,Влад,x@y.com" [--desc "<text>"] [--yes]',
    );
    process.exit(1);
  }
  const title = flag("title");
  const start = flag("start");
  if (!title || !start) {
    console.error("Both --title and --start are required.");
    process.exit(1);
  }
  const attendees = (flag("attendees") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  let end = flag("end");
  if (!end) {
    const duration = Number(flag("duration") ?? "30");
    if (!Number.isFinite(duration) || duration <= 0) {
      console.error("--duration must be a positive number of minutes.");
      process.exit(1);
    }
    const computed = addMinutesIso(start, duration);
    if (!computed) {
      console.error(`Cannot parse --start "${start}" (expect ISO, e.g. 2026-07-08T15:00).`);
      process.exit(1);
    }
    end = computed;
  }

  const proposal = await calendarCreateProposal({
    title,
    startIso: start,
    endIso: end,
    attendees,
    description: flag("desc") ?? "",
  });
  console.log(proposal.echoUk);
  if (!has("yes")) {
    console.log("DRY-RUN — nothing created, no invites sent. Re-run with --yes to create.");
    return;
  }
  console.log(await proposal.apply());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm script**

In `package.json`, after the `"jira-write"` line, add:

```json
    "calendar-write": "node --conditions=react-server --import tsx scripts/calendar-write.ts",
```

- [ ] **Step 3: Verify the dry-run end-to-end (no env needed)**

Run: `npm run calendar-write -- create --title "Тест" --start "2099-01-05T15:00" --attendees "x@y.com"`
Expected output: the Ukrainian proposal echo — «📅 Створю зустріч «Тест»», «Коли: 2099-01-05 15:00–15:30 (Київ)», «Учасники: x@y.com», Google Meet line, followed by `DRY-RUN — nothing created, no invites sent. Re-run with --yes to create.` Exit code 0, no network calls.

Also verify the failure path:
Run: `npm run calendar-write -- create --title "Тест" --start "2099-01-05T15:00" --attendees "Xyzzy Nobody"`
Expected: exits 1 with «Xyzzy Nobody» не знайдено в реєстрі…

- [ ] **Step 4: Add the env documentation**

In `.env.example`, after the `GOOGLE_SERVICE_ACCOUNT_KEY=` block, add:

```
# --- Google Calendar (server-side only) ---
# The Workspace account the bot impersonates when creating meetings — events
# are organized by (and editable from) this account, on its primary calendar.
# Requires a ONE-TIME admin grant: Google Admin console → Security → Access and
# data control → API controls → Domain-wide delegation → add the service
# account's client ID with the single scope
#   https://www.googleapis.com/auth/calendar.events
# Reuses GOOGLE_SERVICE_ACCOUNT_KEY above. Until the grant is done, proposals
# and dry-runs work; an actual create fails with an actionable 403 message.
GOOGLE_CALENDAR_ORGANIZER=
```

- [ ] **Step 5: Add the CLAUDE.md command bullet**

In `CLAUDE.md`, in the Commands list directly after the `npm run jira-write` bullet, add:

```markdown
- `npm run calendar-write -- create --title "<text>" --start "YYYY-MM-DDTHH:mm" [--end "..." | --duration 30] --attendees "Тарас,Влад,x@y.com" [--desc "<text>"] [--yes]` — create a Google Calendar meeting (Meet link + real invites) organized by the impersonated `GOOGLE_CALENDAR_ORGANIZER` account (domain-wide delegation on the existing Drive service account, scope `calendar.events`; one-time Admin-console grant — see `.env.example`). Attendees resolve via the `lib/people.ts` roster (`email` field) or raw emails; unknown names fail loudly, never guessed. Naive times are Europe/Kyiv wall time. **DRY-RUN by default** (prints the resolved Ukrainian plan, needs no env); `--yes` creates the event and prints the Meet + Calendar links. The conversational agent's `calendar_create_event` write tool (confirm-first on Slack/web/CLI surfaces) reuses the same propose→apply path via `lib/proposalExecutor.ts`. (See `docs/superpowers/specs/2026-07-07-calendar-meeting-creation-design.md`.)
```

- [ ] **Step 6: Commit**

```bash
git add scripts/calendar-write.ts package.json .env.example CLAUDE.md
git commit -m "feat(calendar): calendar-write CLI + env + docs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Full verification

**Files:** none new.

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all suites PASS (including the pre-existing agent/executor suites).

- [ ] **Step 2: Lint + typecheck via build**

Run: `npm run lint && npm run build`
Expected: no errors. (`lib/googleCalendar.ts` must not be imported from any `"use client"` file — it isn't; only the executor and CLI import it.)

- [ ] **Step 3: Commit any fixes; otherwise done**

If steps 1–2 surfaced fixes, commit them:

```bash
git add -A && git commit -m "fix(calendar): verification fixes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Post-merge operator checklist (not code — do not automate)

1. Pick/create the organizer account and set `GOOGLE_CALENDAR_ORGANIZER` in Vercel + local `.env`.
2. Google Admin console → Security → Access and data control → API controls → Domain-wide delegation → add the service account's **client ID** (from the `GOOGLE_SERVICE_ACCOUNT_KEY` JSON, field `client_id`) with scope `https://www.googleapis.com/auth/calendar.events`.
3. Fill `email` on `lib/people.ts` entries who should be invitable by name.
4. Smoke test: `npm run calendar-write -- create --title "Тест" --start "<tomorrow>T15:00" --attendees "<your email>" --yes` — expect an invite in your inbox with a Meet link.
