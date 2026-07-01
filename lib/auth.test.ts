import { describe, it, expect } from "vitest";
import {
  isAllowed,
  signSession,
  verifySession,
  decodeIdToken,
  SESSION_TTL_MS,
  type SessionPayload,
} from "./auth";
import { ALLOWED_USERS } from "./allowedUsers";

const SECRET = "test-secret-at-least-32-bytes-long-xxxxx";

// Build an unsigned Slack-style id_token (header.payload.sig) for decode tests.
// We never verify the signature (trusted backchannel), so the sig segment is filler.
function b64url(obj: unknown): string {
  const json = JSON.stringify(obj);
  return Buffer.from(json, "utf8").toString("base64url");
}
function makeIdToken(claims: Record<string, unknown>): string {
  return `${b64url({ alg: "RS256" })}.${b64url(claims)}.sig`;
}
const NOW = 1_750_000_000_000; // fixed epoch ms for deterministic tests
function baseClaims(over: Record<string, unknown> = {}) {
  return {
    iss: "https://slack.com",
    aud: "client-123",
    exp: Math.floor(NOW / 1000) + 600, // seconds, +10 min
    nonce: "nonce-abc",
    "https://slack.com/user_id": "U08G4EC244X",
    name: "Oleksandr K",
    email: "o@example.com",
    ...over,
  };
}

describe("isAllowed", () => {
  it("admits a seeded user id and rejects an unknown one", () => {
    expect(isAllowed(ALLOWED_USERS[0].userId)).toBe(true);
    expect(isAllowed("U_NOT_REAL")).toBe(false);
  });
});

describe("session sign/verify", () => {
  it("round-trips a valid session", async () => {
    const payload: SessionPayload = { userId: "U1", name: "A", exp: NOW + SESSION_TTL_MS };
    const token = await signSession(payload, SECRET);
    const res = await verifySession(token, SECRET, NOW);
    expect(res.valid).toBe(true);
    expect(res.expired).toBe(false);
    expect(res.payload).toEqual(payload);
  });

  it("rejects a tampered payload", async () => {
    const token = await signSession({ userId: "U1", name: "A", exp: NOW + SESSION_TTL_MS }, SECRET);
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ userId: "U2", name: "Evil", exp: NOW + SESSION_TTL_MS }), "utf8").toString("base64url");
    const res = await verifySession(`${forged}.${sig}`, SECRET, NOW);
    expect(res.valid).toBe(false);
  });

  it("rejects a wrong secret", async () => {
    const token = await signSession({ userId: "U1", name: "A", exp: NOW + SESSION_TTL_MS }, SECRET);
    const res = await verifySession(token, "different-secret-also-32-bytes-xxxxxxx", NOW);
    expect(res.valid).toBe(false);
  });

  it("reports an expired (but authentic) session", async () => {
    const token = await signSession({ userId: "U1", name: "A", exp: NOW - 1 }, SECRET);
    const res = await verifySession(token, SECRET, NOW);
    expect(res.valid).toBe(false);
    expect(res.expired).toBe(true);
  });

  it("rejects a malformed token", async () => {
    const res = await verifySession("not-a-token", SECRET, NOW);
    expect(res.valid).toBe(false);
  });
});

describe("decodeIdToken", () => {
  it("extracts user id + name from valid claims", () => {
    const tok = makeIdToken(baseClaims());
    const c = decodeIdToken(tok, { audience: "client-123", nonce: "nonce-abc", now: NOW });
    expect(c.userId).toBe("U08G4EC244X");
    expect(c.name).toBe("Oleksandr K");
  });

  it("throws on wrong audience", () => {
    const tok = makeIdToken(baseClaims({ aud: "someone-else" }));
    expect(() => decodeIdToken(tok, { audience: "client-123", nonce: "nonce-abc", now: NOW })).toThrow();
  });

  it("throws on nonce mismatch", () => {
    const tok = makeIdToken(baseClaims({ nonce: "wrong" }));
    expect(() => decodeIdToken(tok, { audience: "client-123", nonce: "nonce-abc", now: NOW })).toThrow();
  });

  it("throws on expired id_token", () => {
    const tok = makeIdToken(baseClaims({ exp: Math.floor(NOW / 1000) - 10 }));
    expect(() => decodeIdToken(tok, { audience: "client-123", nonce: "nonce-abc", now: NOW })).toThrow();
  });

  it("throws on wrong issuer", () => {
    const tok = makeIdToken(baseClaims({ iss: "https://evil.example" }));
    expect(() => decodeIdToken(tok, { audience: "client-123", nonce: "nonce-abc", now: NOW })).toThrow();
  });
});
