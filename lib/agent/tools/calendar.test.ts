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
