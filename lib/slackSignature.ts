/**
 * Verify Slack's v0 request signature (HMAC-SHA256 over `v0:<ts>:<rawBody>`).
 * PURE — `nowSec`/`maxSkewSec` are injected so it is deterministic and unit-tested;
 * no clock read, no env access. The events route reads SLACK_SIGNING_SECRET and
 * passes it in. See https://api.slack.com/authentication/verifying-requests-from-slack.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyArgs {
  /** Slack app "Signing Secret" (Basic Information → App Credentials). */
  signingSecret: string;
  /** The `X-Slack-Signature` header value (e.g. `v0=…`). */
  signature: string | null;
  /** The `X-Slack-Request-Timestamp` header value (Unix seconds). */
  timestamp: string | null;
  /** The exact, unparsed request body. */
  rawBody: string;
  /** Current time in Unix seconds (injected for testability). */
  nowSec: number;
  /** Max accepted clock skew, in seconds (replay guard). Default 300 (5 min). */
  maxSkewSec?: number;
}

export function verifySlackSignature(args: VerifyArgs): boolean {
  const { signingSecret, signature, timestamp, rawBody, nowSec, maxSkewSec = 300 } = args;
  if (!signingSecret || !signature || !timestamp) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > maxSkewSec) return false; // replay guard

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;

  // Constant-time compare; timingSafeEqual throws on length mismatch, so guard it.
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
