import { describe, expect, it } from "vitest";
import { outboundMessages } from "./schema";

describe("outbound_messages schema", () => {
  it("exposes the expected primary key and columns", () => {
    expect(outboundMessages.key.name).toBe("key");
    expect(outboundMessages.key.primary).toBe(true);
    expect(outboundMessages.status.name).toBe("status");
    expect(outboundMessages.origin.name).toBe("origin");
    expect(outboundMessages.trigger.name).toBe("trigger");
    expect(outboundMessages.attempts.name).toBe("attempts");
  });
});
