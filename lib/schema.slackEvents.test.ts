import { describe, expect, it } from "vitest";
import { slackEventsSeen } from "./schema";

describe("slack_events_seen schema", () => {
  it("exposes event_id as the primary key plus audit columns", () => {
    expect(slackEventsSeen.eventId.name).toBe("event_id");
    expect(slackEventsSeen.eventId.primary).toBe(true);
    expect(slackEventsSeen.seenAt.name).toBe("seen_at");
    expect(slackEventsSeen.eventType.name).toBe("event_type");
    expect(slackEventsSeen.outcome.name).toBe("outcome");
  });
});
