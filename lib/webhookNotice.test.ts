import { describe, it, expect } from "vitest";
import { formatWebhookFailureNotice } from "./webhookNotice";

describe("formatWebhookFailureNotice", () => {
  it("surfaces a warning marker, the reason, and the operator hint", () => {
    const msg = formatWebhookFailureNotice(
      "ANTHROPIC_API_KEY is not set on the server (needed for approval classification).",
    );
    expect(msg).toContain("⚠️");
    expect(msg).toContain("ANTHROPIC_API_KEY is not set");
    expect(msg.toLowerCase()).toContain("operator");
  });

  it("trims an overly long reason so it stays a terse notice", () => {
    const msg = formatWebhookFailureNotice("x".repeat(1000));
    expect(msg.length).toBeLessThan(400);
  });

  it("falls back to 'unknown error' when the reason is blank", () => {
    expect(formatWebhookFailureNotice("   ")).toContain("unknown error");
  });
});
