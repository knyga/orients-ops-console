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
