import { describe, expect, it } from "vitest";
import { parseSlackEvent } from "./slackEventParse";

const reply = {
  type: "message" as const,
  user: "U08G4EC244X",
  text: "ні, не прийнято",
  ts: "1782899951.295969",
  thread_ts: "1782897379.356719",
  channel: "C08GY2NKF9D",
};

describe("parseSlackEvent", () => {
  it("returns the challenge for url_verification", () => {
    expect(parseSlackEvent({ type: "url_verification", challenge: "abc123" })).toEqual({
      kind: "challenge",
      challenge: "abc123",
    });
  });

  it("skips a non event_callback envelope", () => {
    expect(parseSlackEvent({ type: "app_rate_limited" })).toEqual({
      kind: "skip",
      reason: "not-event-callback",
    });
  });

  it("skips a bot message", () => {
    expect(
      parseSlackEvent({ type: "event_callback", event: { ...reply, bot_id: "B1" } }).kind,
    ).toBe("skip");
  });

  it("skips a message with a subtype (edit/join/etc)", () => {
    expect(
      parseSlackEvent({ type: "event_callback", event: { ...reply, subtype: "message_changed" } })
        .kind,
    ).toBe("skip");
  });

  it("skips a top-level message (not a thread reply)", () => {
    expect(
      parseSlackEvent({
        type: "event_callback",
        event: { ...reply, thread_ts: reply.ts },
      }).kind,
    ).toBe("skip");
  });

  it("returns actionable with the event_id and reply fields for a human thread reply", () => {
    expect(
      parseSlackEvent({ type: "event_callback", event_id: "Ev123", event: reply }),
    ).toEqual({
      kind: "actionable",
      eventId: "Ev123",
      channelId: "C08GY2NKF9D",
      userId: "U08G4EC244X",
      replyText: "ні, не прийнято",
      replyTs: "1782899951.295969",
      threadTs: "1782897379.356719",
    });
  });

  it("is actionable with eventId null when event_id is absent (fail open)", () => {
    const r = parseSlackEvent({ type: "event_callback", event: reply });
    expect(r.kind).toBe("actionable");
    if (r.kind === "actionable") expect(r.eventId).toBeNull();
  });
});
