import { describe, it, expect } from "vitest";
import { formatWebhookFailureNotice } from "./webhookNotice";

describe("formatWebhookFailureNotice", () => {
  it("surfaces a warning marker, the reason, and the operator hint", () => {
    const msg = formatWebhookFailureNotice(
      "ANTHROPIC_API_KEY is not set on the server (needed for approval classification).",
    );
    expect(msg).toContain("⚠️");
    // The raw technical error passes through verbatim (not translated).
    expect(msg).toContain("ANTHROPIC_API_KEY is not set");
    expect(msg).toContain("оператора");
  });

  it("trims an overly long reason so it stays a terse notice", () => {
    const msg = formatWebhookFailureNotice("x".repeat(1000));
    expect(msg.length).toBeLessThan(450);
  });

  it("falls back to 'невідома помилка' when the reason is blank", () => {
    expect(formatWebhookFailureNotice("   ")).toContain("невідома помилка");
  });
});
