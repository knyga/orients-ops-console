# Slack Auth Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the ops console (dashboard pages + data API routes) behind a "Sign in with Slack" login, authorized by a hardcoded allowlist of Slack user ids.

**Architecture:** Hand-rolled OpenID Connect authorization-code flow against Slack, with our own HMAC-signed httpOnly session cookie. A pure, unit-tested `lib/auth.ts` holds the crypto + allowlist logic (shared by web middleware, auth routes, and a CLI). A `server-only` `lib/slackOidc.ts` builds the authorize URL and exchanges the code. `middleware.ts` enforces the session on every covered request.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Web Crypto (`crypto.subtle`) for edge-runtime-safe HMAC, Vitest. No new runtime dependencies.

## Global Constraints

- **Two interfaces:** every feature ships a web AND a CLI surface; shared logic lives in pure `lib/` modules. (CLAUDE.md, non-negotiable.)
- **No new runtime dependencies.** Use Web Crypto + built-ins only.
- **Server-only token isolation:** `SLACK_CLIENT_SECRET` is read only in `lib/slackOidc.ts` (imports `server-only`); it must never reach the browser bundle.
- **Edge-safe crypto:** `lib/auth.ts` runs in the edge middleware runtime — use `crypto.subtle` / `btoa` / `atob` / `TextEncoder`, never `node:crypto` or `node:*` imports. `lib/auth.ts` must NOT import `server-only` (it is used by the CLI too).
- **CLIs run under** `node --conditions=react-server --import tsx` (so any `server-only` import resolves to its empty module), and call `process.loadEnvFile()` in a try/catch before reading env.
- **Import alias:** `@/*` maps to the repo root.
- **Machine endpoints stay open:** `/api/cron/*` (CRON_SECRET) and `/api/slack/*` (request-signature) are NOT gated by the human login.
- **Session:** payload `{ userId, name, exp }`, `exp = now + 7 days` fixed; cookie `httpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, `Max-Age=604800`, name `ooc_session`.

---

### Task 1: Allowlist + pure auth core

**Files:**
- Create: `lib/allowedUsers.ts`
- Create: `lib/auth.ts`
- Test: `lib/auth.test.ts`

**Interfaces:**
- Consumes: nothing (foundation task).
- Produces:
  - `lib/allowedUsers.ts`: `interface AllowedUser { userId: string; name: string }`, `const ALLOWED_USERS: AllowedUser[]`, `function allowedUserFor(userId: string): AllowedUser | undefined`.
  - `lib/auth.ts`:
    - `interface SessionPayload { userId: string; name: string; exp: number }` (`exp` = epoch **ms**).
    - `function isAllowed(userId: string): boolean`.
    - `async function signSession(payload: SessionPayload, secret: string): Promise<string>`.
    - `async function verifySession(token: string, secret: string, now?: number): Promise<{ valid: boolean; expired: boolean; payload?: SessionPayload }>`.
    - `interface IdTokenClaims { userId: string; name: string; email?: string }`.
    - `function decodeIdToken(idToken: string, opts: { audience: string; nonce: string; now?: number }): IdTokenClaims` — throws `Error` on any validation failure.
    - `const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000`.

- [ ] **Step 1: Write the failing test**

Create `lib/auth.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/auth.test.ts`
Expected: FAIL — `Cannot find module './auth'` / `./allowedUsers`.

- [ ] **Step 3: Create the allowlist**

Create `lib/allowedUsers.ts`:

```ts
/**
 * Console access allowlist — the Slack user ids permitted to sign in to the ops
 * console. Hardcoded for the Orients workspace (like lib/approvers.ts):
 * membership is a deliberate, auditable decision, not config.
 *
 * Kept SEPARATE from lib/approvers.ts on purpose: "can log in" and "can override
 * a verdict" are distinct authorizations that may diverge. Seeded with the two
 * approvers; add ids here (then redeploy) to grant access.
 */
export interface AllowedUser {
  /** Slack user id (U…). */
  userId: string;
  name: string;
}

export const ALLOWED_USERS: AllowedUser[] = [
  { userId: "U08G4EC244X", name: "Oleksandr K" },
  { userId: "U08G4HZQTTR", name: "Bohdan Forostianyi" },
];

/** The allowed user for a Slack user id, or undefined if not permitted. */
export function allowedUserFor(userId: string): AllowedUser | undefined {
  return ALLOWED_USERS.find((u) => u.userId === userId);
}
```

- [ ] **Step 4: Create the pure auth core**

Create `lib/auth.ts`:

```ts
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run lib/auth.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add lib/auth.ts lib/allowedUsers.ts lib/auth.test.ts
git commit -m "feat(auth): pure session crypto + Slack id_token decode + allowlist"
```

---

### Task 2: Slack OIDC client (server-only)

**Files:**
- Create: `lib/slackOidc.ts`
- Modify: `.env.example` (append the auth env block)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `function buildAuthorizeUrl(args: { state: string; nonce: string; redirectUri: string }): string`.
  - `async function exchangeCode(args: { code: string; redirectUri: string }): Promise<{ idToken: string }>` — POSTs to Slack's token endpoint; throws on non-ok / `ok:false`.
  - `function clientId(): string` — returns `SLACK_CLIENT_ID` (throws if unset). Used by the callback route to pass `audience` into `decodeIdToken`.

- [ ] **Step 1: Create the OIDC client**

Create `lib/slackOidc.ts`:

```ts
/**
 * Slack OpenID Connect client (server-only). Builds the "Sign in with Slack"
 * authorize URL and exchanges the authorization code for an id_token over a
 * direct TLS backchannel. Reads SLACK_CLIENT_ID / SLACK_CLIENT_SECRET; the
 * secret must never reach the browser — `server-only` makes an accidental
 * client import a build error.
 */
import "server-only";

const AUTHORIZE_URL = "https://slack.com/openid/connect/authorize";
const TOKEN_URL = "https://slack.com/api/openid.connect.token";

export function clientId(): string {
  const id = process.env.SLACK_CLIENT_ID;
  if (!id) throw new Error("SLACK_CLIENT_ID is not set");
  return id;
}

function clientSecret(): string {
  const secret = process.env.SLACK_CLIENT_SECRET;
  if (!secret) throw new Error("SLACK_CLIENT_SECRET is not set");
  return secret;
}

export function buildAuthorizeUrl(args: { state: string; nonce: string; redirectUri: string }): string {
  const params = new URLSearchParams({
    response_type: "code",
    scope: "openid email profile",
    client_id: clientId(),
    state: args.state,
    nonce: args.nonce,
    redirect_uri: args.redirectUri,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeCode(args: { code: string; redirectUri: string }): Promise<{ idToken: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: clientId(),
    client_secret: clientSecret(),
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Slack token endpoint HTTP ${res.status}`);
  const json = (await res.json()) as { ok?: boolean; error?: string; id_token?: string };
  if (!json.ok || !json.id_token) throw new Error(`Slack token exchange failed: ${json.error ?? "no id_token"}`);
  return { idToken: json.id_token };
}
```

- [ ] **Step 2: Append the auth env block to `.env.example`**

Add at the end of `.env.example`:

```bash
# --- Console auth (Sign in with Slack / OIDC) ---
# The console gates all dashboard pages + data API routes behind a Slack login
# (allowlist in lib/allowedUsers.ts). Create a Slack app with the OpenID Connect
# scopes (openid, email, profile) and register the redirect URL
# <AUTH_BASE_URL>/api/auth/callback under OAuth & Permissions.
SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=
# Random secret (>=32 bytes) used to HMAC-sign the session cookie. Generate with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
AUTH_SECRET=
# Public base URL used to build the OAuth redirect_uri. Local: http://localhost:3003
# Prod: the deployed origin (e.g. https://ops.example.com). No trailing slash.
AUTH_BASE_URL=http://localhost:3003
```

- [ ] **Step 3: Verify it builds / lints**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors referencing `lib/slackOidc.ts`.

- [ ] **Step 4: Commit**

```bash
git add lib/slackOidc.ts .env.example
git commit -m "feat(auth): Slack OIDC client (authorize URL + code exchange) + env"
```

---

### Task 3: Auth routes (login, callback, logout)

**Files:**
- Create: `app/api/auth/login/route.ts`
- Create: `app/api/auth/callback/route.ts`
- Create: `app/api/auth/logout/route.ts`
- Create: `lib/authCookies.ts` (shared cookie names + a `redirectUri()` helper)

**Interfaces:**
- Consumes: `signSession`, `decodeIdToken`, `isAllowed`, `SESSION_TTL_MS` (Task 1); `buildAuthorizeUrl`, `exchangeCode`, `clientId` (Task 2).
- Produces:
  - `lib/authCookies.ts`: `const SESSION_COOKIE = "ooc_session"`, `const STATE_COOKIE = "ooc_oauth_state"`, `const NONCE_COOKIE = "ooc_oauth_nonce"`, `function redirectUri(request: Request): string`, `function authSecret(): string`.

- [ ] **Step 1: Create shared cookie helpers**

Create `lib/authCookies.ts`:

```ts
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
```

- [ ] **Step 2: Create the login route**

Create `app/api/auth/login/route.ts`:

```ts
import { NextResponse } from "next/server";
import { buildAuthorizeUrl } from "@/lib/slackOidc";
import { redirectUri, STATE_COOKIE, NONCE_COOKIE } from "@/lib/authCookies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/auth/login — start the Slack OIDC flow. */
export async function GET(request: Request) {
  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const url = buildAuthorizeUrl({ state, nonce, redirectUri: redirectUri(request) });

  const res = NextResponse.redirect(url);
  const cookieOpts = { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/", maxAge: 600 };
  res.cookies.set(STATE_COOKIE, state, cookieOpts);
  res.cookies.set(NONCE_COOKIE, nonce, cookieOpts);
  return res;
}
```

- [ ] **Step 3: Create the callback route**

Create `app/api/auth/callback/route.ts`:

```ts
import { NextResponse } from "next/server";
import { exchangeCode, clientId } from "@/lib/slackOidc";
import { decodeIdToken, isAllowed, signSession, SESSION_TTL_MS } from "@/lib/auth";
import {
  redirectUri,
  authSecret,
  SESSION_COOKIE,
  STATE_COOKIE,
  NONCE_COOKIE,
} from "@/lib/authCookies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/auth/callback?code&state — finish the Slack OIDC flow. */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const stateCookie = request.headers.get("cookie")?.match(/ooc_oauth_state=([^;]+)/)?.[1];
  const nonce = request.headers.get("cookie")?.match(/ooc_oauth_nonce=([^;]+)/)?.[1];

  const fail = (reason: string) => {
    const res = NextResponse.redirect(`${origin}/login?denied=1&reason=${encodeURIComponent(reason)}`);
    res.cookies.delete(STATE_COOKIE);
    res.cookies.delete(NONCE_COOKIE);
    return res;
  };

  if (!code || !state || !stateCookie || state !== stateCookie || !nonce) {
    return fail("bad_state");
  }

  let idToken: string;
  try {
    ({ idToken } = await exchangeCode({ code, redirectUri: redirectUri(request) }));
  } catch {
    return fail("exchange_failed");
  }

  let userId: string;
  let name: string;
  try {
    const claims = decodeIdToken(idToken, { audience: clientId(), nonce });
    userId = claims.userId;
    name = claims.name;
  } catch {
    return fail("bad_token");
  }

  if (!isAllowed(userId)) return fail("not_allowed");

  const token = await signSession({ userId, name, exp: Date.now() + SESSION_TTL_MS }, authSecret());
  const res = NextResponse.redirect(`${origin}/`);
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  res.cookies.delete(STATE_COOKIE);
  res.cookies.delete(NONCE_COOKIE);
  return res;
}
```

- [ ] **Step 4: Create the logout route**

Create `app/api/auth/logout/route.ts`:

```ts
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/authCookies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/auth/logout — clear the session and return to /login. */
export async function GET(request: Request) {
  const { origin } = new URL(request.url);
  const res = NextResponse.redirect(`${origin}/login`);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
```

- [ ] **Step 5: Verify it builds**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors in the new route files.

- [ ] **Step 6: Commit**

```bash
git add app/api/auth lib/authCookies.ts
git commit -m "feat(auth): login/callback/logout routes + shared cookie helpers"
```

---

### Task 4: Middleware enforcement

**Files:**
- Create: `middleware.ts` (repo root)

**Interfaces:**
- Consumes: `verifySession` (Task 1), `SESSION_COOKIE`, `authSecret` (Task 3).
- Produces: nothing (terminal enforcement layer).

- [ ] **Step 1: Create the middleware**

Create `middleware.ts` at the repo root:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/authCookies";

/**
 * Auth gate. Every request matched by `config.matcher` (everything except the
 * bypass paths + static assets) must carry a valid session cookie. Pages get a
 * 302 to /login; API routes get 401 JSON. Runs in the edge runtime — verifySession
 * uses Web Crypto only.
 *
 * Bypass (own auth / public): /api/auth/*, /api/cron/*, /api/slack/*, /login.
 */
export async function middleware(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const secret = process.env.AUTH_SECRET;

  let ok = false;
  if (token && secret) {
    const res = await verifySession(token, secret);
    ok = res.valid;
  }
  if (ok) return NextResponse.next();

  const isApi = request.nextUrl.pathname.startsWith("/api/");
  if (isApi) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const loginUrl = new URL("/login", request.url);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Run on everything EXCEPT: the login flow, machine endpoints (own auth),
  // the login page, and Next static assets.
  matcher: ["/((?!api/auth|api/cron|api/slack|login|_next/static|_next/image|favicon.ico).*)"],
};
```

- [ ] **Step 2: Manually verify the matcher logic (reasoning check, no code)**

Confirm against the regex `((?!api/auth|api/cron|api/slack|login|_next/static|_next/image|favicon.ico).*)`:
- `/` → matched (gated) ✓
- `/field-ops` → matched (gated) ✓
- `/api/vimeo` → matched (gated) ✓
- `/api/auth/login` → NOT matched (bypass) ✓
- `/api/cron/sync` → NOT matched (bypass) ✓
- `/api/slack/events` → NOT matched (bypass) ✓
- `/login` → NOT matched (bypass) ✓
- `/_next/static/...` → NOT matched ✓

- [ ] **Step 3: Build to confirm middleware compiles in the edge runtime**

Run: `npm run build`
Expected: build succeeds; the build output lists `ƒ Middleware`. No "node:crypto not supported in edge" errors (we use Web Crypto).

- [ ] **Step 4: Commit**

```bash
git add middleware.ts
git commit -m "feat(auth): middleware gate for pages + data APIs"
```

---

### Task 5: Login page

**Files:**
- Create: `app/login/page.tsx`

**Interfaces:**
- Consumes: nothing (links to `/api/auth/login`).
- Produces: nothing.

- [ ] **Step 1: Create the login page**

Create `app/login/page.tsx`. Note: this lives OUTSIDE the `(dashboard)` group, so it does NOT render the dashboard nav shell. `searchParams` is a Promise in Next 16.

```tsx
/**
 * Login page (outside the dashboard shell). One "Sign in with Slack" button →
 * GET /api/auth/login. Shows a denied message when redirected back with
 * ?denied=1 (e.g. a workspace member who is not on the allowlist).
 */
export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string; reason?: string }>;
}) {
  const { denied } = await searchParams;

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-lg font-semibold tracking-tight text-slate-900">
          Orients Ops Console
        </h1>
        <p className="mt-1 text-sm text-slate-500">Sign in to continue.</p>

        {denied ? (
          <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            Your Slack account isn’t authorized for this console. Ask an admin to
            add you to the allowlist.
          </p>
        ) : null}

        <a
          href="/api/auth/login"
          className="mt-6 flex h-10 w-full items-center justify-center rounded-md bg-slate-900 text-sm font-medium text-white hover:bg-slate-800"
        >
          Sign in with Slack
        </a>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify it builds**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/login/page.tsx
git commit -m "feat(auth): login page with Sign in with Slack button"
```

---

### Task 6: `access` CLI (the second interface)

**Files:**
- Create: `scripts/access.ts`
- Modify: `package.json` (add the `access` script)

**Interfaces:**
- Consumes: `ALLOWED_USERS` (Task 1), `verifySession` (Task 1), `authSecret` (Task 3).
- Produces: nothing.

- [ ] **Step 1: Add the npm script**

In `package.json`, under `"scripts"`, add after the `"backfill-outbound"` line:

```json
    "access": "node --conditions=react-server --import tsx scripts/access.ts",
```

- [ ] **Step 2: Create the CLI**

Create `scripts/access.ts`:

```ts
/**
 * CLI: the second interface for the console auth gate. Same code path as the web
 * (lib/auth.ts / lib/allowedUsers.ts).
 *
 * Usage:
 *   npm run access -- list [--format table]
 *   npm run access -- verify <cookie-value>
 *
 * Runs under `--conditions=react-server` so any server-only import resolves.
 */
import { ALLOWED_USERS } from "../lib/allowedUsers";
import { verifySession } from "../lib/auth";
import { authSecret } from "../lib/authCookies";

function formatTable(): string {
  const lines = ["userId         name", "-------------- --------------------"];
  for (const u of ALLOWED_USERS) lines.push(`${u.userId.padEnd(14)} ${u.name}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    /* rely on ambient env */
  }

  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === "list") {
    if (argv.includes("--format") && argv[argv.indexOf("--format") + 1] === "table") {
      console.log(formatTable());
    } else {
      console.log(JSON.stringify({ count: ALLOWED_USERS.length, users: ALLOWED_USERS }, null, 2));
    }
    return;
  }

  if (cmd === "verify") {
    const token = argv[1];
    if (!token) throw new Error("usage: npm run access -- verify <cookie-value>");
    const res = await verifySession(token, authSecret());
    console.log(
      JSON.stringify(
        {
          valid: res.valid,
          expired: res.expired,
          userId: res.payload?.userId ?? null,
          name: res.payload?.name ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }

  throw new Error("usage: npm run access -- <list|verify> [...]");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`access: ${message}\n`);
  process.exit(1);
});
```

- [ ] **Step 3: Verify `list` works**

Run: `npm run access -- list`
Expected: JSON with `count: 2` and the two seeded users.

Run: `npm run access -- list --format table`
Expected: a two-row table with the seeded users.

- [ ] **Step 4: Verify `verify` round-trips against a minted token**

Run:
```bash
AUTH_SECRET=test-secret-at-least-32-bytes-long-xxxxx node --conditions=react-server --import tsx -e "import('./lib/auth.ts').then(async m => { const t = await m.signSession({userId:'U1',name:'A',exp:Date.now()+1000000}, 'test-secret-at-least-32-bytes-long-xxxxx'); console.log(t); })"
```
Then feed the printed token:
```bash
AUTH_SECRET=test-secret-at-least-32-bytes-long-xxxxx npm run access -- verify "<token>"
```
Expected: `{ "valid": true, "expired": false, "userId": "U1", "name": "A" }`.

- [ ] **Step 5: Commit**

```bash
git add scripts/access.ts package.json
git commit -m "feat(auth): access CLI (list allowlist + verify session) — second interface"
```

---

### Task 7: Update CLAUDE.md + final verification

**Files:**
- Modify: `CLAUDE.md` (Commands section)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Document the CLI in CLAUDE.md**

In `CLAUDE.md`, in the `## Commands` list, add a bullet (after the `backfill-outbound` mention or near the other CLIs):

```markdown
- `npm run access -- <list|verify>` — inspect the console auth gate. `list` prints the Slack-user-id allowlist (`lib/allowedUsers.ts`); `--format table` for a human view. `verify <cookie-value>` decodes/validates a session cookie. The console gates all dashboard pages + data API routes behind a Slack OIDC login (`proxy.ts`, Next 16's renamed middleware); machine endpoints (`/api/cron/*`, `/api/slack/*`) keep their own auth. (See `docs/superpowers/specs/2026-06-30-slack-auth-gate-design.md`.)
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including `lib/auth.test.ts`.

- [ ] **Step 3: Run the full build**

Run: `npm run build`
Expected: build succeeds with middleware listed.

- [ ] **Step 4: Manual smoke test (local)**

With `AUTH_SECRET`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `AUTH_BASE_URL=http://localhost:3003` set in `.env`:
1. `npm run dev`, open `http://localhost:3003/` → redirected to `/login`.
2. Click "Sign in with Slack" → Slack consent → back to `/`.
   - As an allowlisted user: lands on the dashboard.
   - As a non-allowlisted workspace member: lands on `/login?denied=1` with the denied message.
3. `curl -s -o /dev/null -w "%{http_code}" http://localhost:3003/api/vimeo` (no cookie) → `401`.
4. Visit `/api/auth/logout` → back to `/login`; dashboard now redirects again.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(auth): document the access CLI + auth gate in CLAUDE.md"
```

---

## Self-Review notes

- **Spec coverage:** OIDC flow (T2/T3), state+nonce CSRF (T3), id_token validation incl. iss/aud/exp/nonce (T1 `decodeIdToken`), allowlist (T1), session cookie HMAC + attributes (T1/T3), middleware gating pages+APIs with cron/slack/auth/login bypass (T4), login page incl. denied state (T5), logout (T3), CLI `list`+`verify` (T6), env vars (T2), tests (T1), CLAUDE.md (T7). All spec sections map to a task.
- **Edge-safety:** `lib/auth.ts` + `lib/authCookies.ts` use no `node:*` imports and no `server-only`, so the edge middleware can import them. `lib/slackOidc.ts` (server-only) is imported only by Node-runtime routes, never by middleware.
- **Type consistency:** `SessionPayload.exp` is epoch **ms** everywhere; `decodeIdToken` treats the id_token `exp` claim as **seconds** (Slack/JWT convention) and multiplies by 1000 — these are deliberately different and isolated to their own functions.
