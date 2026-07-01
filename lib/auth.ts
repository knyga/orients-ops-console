/**
 * Pure auth core — shared by the web middleware, the /api/auth routes, and the
 * `access` CLI. Edge-runtime-safe: uses Web Crypto only (no node:crypto), and
 * does NOT import `server-only` (the CLI imports it too).
 *
 *   - session cookie: base64url(JSON payload) + "." + base64url(HMAC-SHA256)
 *   - id_token: decoded (NOT signature-verified — it arrives over a trusted
 *     TLS backchannel from Slack's token endpoint); we validate iss/aud/exp/nonce.
 */
import { allowedUserFor } from "./allowedUsers";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionPayload {
  userId: string;
  name: string;
  /** Expiry as epoch milliseconds. */
  exp: number;
}

export interface IdTokenClaims {
  userId: string;
  name: string;
  email?: string;
}

const enc = new TextEncoder();

function bytesToB64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function strToB64url(str: string): string {
  return bytesToB64url(enc.encode(str));
}
function b64urlToStr(b64url: string): string {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function hmac(data: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return new Uint8Array(sig);
}

/** Constant-time byte comparison. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Whether a Slack user id is allowed to access the console. */
export function isAllowed(userId: string): boolean {
  return allowedUserFor(userId) !== undefined;
}

/** Mint a signed session token for a payload. */
export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const body = strToB64url(JSON.stringify(payload));
  const sig = bytesToB64url(await hmac(body, secret));
  return `${body}.${sig}`;
}

/** Verify + decode a session token. Never throws. */
export async function verifySession(
  token: string,
  secret: string,
  now: number = Date.now(),
): Promise<{ valid: boolean; expired: boolean; payload?: SessionPayload }> {
  const parts = token.split(".");
  if (parts.length !== 2) return { valid: false, expired: false };
  const [body, sig] = parts;
  let expected: Uint8Array;
  try {
    expected = await hmac(body, secret);
  } catch {
    return { valid: false, expired: false };
  }
  let given: Uint8Array;
  try {
    const bin = atob(sig.replace(/-/g, "+").replace(/_/g, "/"));
    given = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) given[i] = bin.charCodeAt(i);
  } catch {
    return { valid: false, expired: false };
  }
  if (!timingSafeEqual(expected, given)) return { valid: false, expired: false };

  let payload: SessionPayload;
  try {
    payload = JSON.parse(b64urlToStr(body)) as SessionPayload;
  } catch {
    return { valid: false, expired: false };
  }
  if (typeof payload.exp !== "number" || payload.exp <= now) {
    return { valid: false, expired: true, payload };
  }
  return { valid: true, expired: false, payload };
}

/**
 * Decode + validate a Slack OIDC id_token. Throws on any validation failure.
 * NOTE: the JWT signature is intentionally NOT verified — the token is fetched
 * over a direct server-to-server TLS call to Slack's token endpoint, never via
 * the browser, so it is trusted by transport (standard code-flow assumption).
 */
export function decodeIdToken(
  idToken: string,
  opts: { audience: string; nonce: string; now?: number },
): IdTokenClaims {
  const now = opts.now ?? Date.now();
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("malformed id_token");

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(b64urlToStr(parts[1])) as Record<string, unknown>;
  } catch {
    throw new Error("undecodable id_token payload");
  }

  if (claims.iss !== "https://slack.com") throw new Error("bad issuer");
  if (claims.aud !== opts.audience) throw new Error("audience mismatch");
  if (claims.nonce !== opts.nonce) throw new Error("nonce mismatch");
  const expSec = claims.exp;
  if (typeof expSec !== "number" || expSec * 1000 <= now) throw new Error("id_token expired");

  const userId = claims["https://slack.com/user_id"];
  if (typeof userId !== "string" || !userId) throw new Error("missing user id claim");
  const name = typeof claims.name === "string" ? claims.name : userId;
  const email = typeof claims.email === "string" ? claims.email : undefined;
  return { userId, name, email };
}
