import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySlackSignature } from "./slackSignature";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const BODY = "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3B";

/** Build the signature Slack would send for a (timestamp, body) pair. */
function sign(timestamp: string, body: string, secret = SECRET): string {
  const digest = createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
  return `v0=${digest}`;
}

describe("verifySlackSignature", () => {
  const nowSec = 1_531_420_618;
  const timestamp = String(nowSec);

  it("accepts a valid signature within the skew window", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signature: sign(timestamp, BODY),
        timestamp,
        rawBody: BODY,
        nowSec,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signature: sign(timestamp, BODY),
        timestamp,
        rawBody: `${BODY}&injected=1`,
        nowSec,
      }),
    ).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signature: sign(timestamp, BODY, "wrong-secret"),
        timestamp,
        rawBody: BODY,
        nowSec,
      }),
    ).toBe(false);
  });

  it("rejects a stale timestamp (replay guard)", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signature: sign(timestamp, BODY),
        timestamp,
        rawBody: BODY,
        nowSec: nowSec + 301, // just past the 5-minute window
      }),
    ).toBe(false);
  });

  it("accepts a timestamp at the edge of the skew window", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signature: sign(timestamp, BODY),
        timestamp,
        rawBody: BODY,
        nowSec: nowSec + 300,
      }),
    ).toBe(true);
  });

  it("rejects missing signature, timestamp, or secret", () => {
    const base = { signature: sign(timestamp, BODY), timestamp, rawBody: BODY, nowSec };
    expect(verifySlackSignature({ ...base, signingSecret: "" })).toBe(false);
    expect(verifySlackSignature({ ...base, signingSecret: SECRET, signature: null })).toBe(false);
    expect(verifySlackSignature({ ...base, signingSecret: SECRET, timestamp: null })).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signature: sign("not-a-number", BODY),
        timestamp: "not-a-number",
        rawBody: BODY,
        nowSec,
      }),
    ).toBe(false);
  });
});
