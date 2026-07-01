/**
 * Shared constants + helpers for the auth cookies and the OAuth redirect URI.
 * Plain module (no server-only) so middleware can import the cookie name too.
 */
export const SESSION_COOKIE = "ooc_session";
export const STATE_COOKIE = "ooc_oauth_state";
export const NONCE_COOKIE = "ooc_oauth_nonce";

/** The OAuth redirect_uri: AUTH_BASE_URL when set, else the request origin. */
export function redirectUri(request: Request): string {
  const base = process.env.AUTH_BASE_URL ?? new URL(request.url).origin;
  return `${base.replace(/\/$/, "")}/api/auth/callback`;
}

/** The HMAC secret for the session cookie (throws if unset). */
export function authSecret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set");
  return s;
}
