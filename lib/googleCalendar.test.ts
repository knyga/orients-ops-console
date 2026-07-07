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
