# Slack sign-in gate for the ops console

**Date:** 2026-06-30
**Status:** Approved (design)

## Problem

The ops console is currently unauthenticated: any visitor who reaches the URL
sees the full dashboard and can fetch every data route (`/api/vimeo`, `/api/jira`,
`/api/github`, `/api/field-*`, `/api/sent`, `/api/policy`, `/api/drive`) directly.
The underlying provider tokens never leak (they stay server-side), but the
computed reports — flight hours, bonuses, dev throughput, verdicts — are exposed.

We want a login gate so only a known set of Slack users can reach the console.

## Goals

- Gate **all human-facing surfaces**: the dashboard pages **and** the data API
  routes listed above.
- Authenticate via **"Sign in with Slack"** (OpenID Connect, authorization-code flow).
- Authorize via a **hardcoded allowlist of Slack user ids**, seeded with the two
  approvers already known to the codebase.
- No new runtime dependencies; match the repo's `server-only` / pure-`lib` /
  hand-rolled style.
- Ship the mandated **second interface**: a CLI that exposes the same
  allowlist/session answers.

## Non-goals

- No user database, password reset, multi-provider, or role hierarchy.
- The machine endpoints keep their **existing** auth and are **not** gated by the
  human login: `/api/cron/*` (guarded by `CRON_SECRET`) and `/api/slack/*`
  (guarded by Slack request-signature verification).
- JWKS signature verification of the Slack `id_token` is **out of scope** for v1
  (see Trust model); noted as optional later hardening.

## Approach

Hand-rolled OIDC + an HMAC-signed httpOnly session cookie. Chosen over Auth.js
(heavy dependency, Next.js 16 compatibility risk, mid-migration churn) and the
OAuth v2 bot flow (strictly more work for the same identity result).

### Flow (authorization-code)

1. Unauthenticated request → the root proxy (`proxy.ts`, Next 16's renamed middleware) redirects pages to `/login`
   (API routes get `401 JSON`).
2. `/login` renders a single **"Sign in with Slack"** button linking to
   `GET /api/auth/login`. If `?denied=1` is present, it shows an
   "not on the allowlist" message.
3. `GET /api/auth/login`:
   - generates a random `state` and `nonce`,
   - stores them in short-lived (10 min) signed httpOnly cookies,
   - redirects to `https://slack.com/openid/connect/authorize` with
     `client_id`, `scope=openid email profile`, `redirect_uri=<base>/api/auth/callback`,
     `state`, `nonce`, `response_type=code`.
4. Slack redirects back to `GET /api/auth/callback?code&state`. The handler:
   - verifies `state` equals the `state` cookie (CSRF) — else 400,
   - exchanges `code` at `https://slack.com/api/openid.connect.token`
     (server-to-server, TLS) for an `id_token`,
   - decodes the `id_token` claims and validates `iss` (`https://slack.com`),
     `aud` (= `SLACK_CLIENT_ID`), `exp` (not expired), and `nonce` (= the cookie),
   - reads the Slack user id claim `https://slack.com/user_id`,
   - checks it against `lib/allowedUsers.ts`:
     - **allowed** → mint a session cookie, clear the `state`/`nonce` cookies,
       redirect to `/`,
     - **not allowed** → redirect to `/login?denied=1` (no session set).
5. `GET /api/auth/logout` clears the session cookie and redirects to `/login`.

### Trust model

The `id_token` arrives over a **direct TLS backchannel** from Slack's token
endpoint (it is never routed through the browser), so we trust it without
fetching Slack's JWKS — the standard code-flow trust assumption. We still
validate `iss`/`aud`/`exp`/`nonce` defensively. JWKS-based signature
verification is deferred as optional hardening.

### Session

- The session is **our own** cookie — we do **not** store Slack's `id_token`.
- Payload: `{ userId, name, exp }` (exp = now + 7 days, fixed; re-login after).
- Format: `base64url(JSON).base64url(HMAC-SHA256(JSON, AUTH_SECRET))`.
- Verification uses a **constant-time** comparison of the HMAC.
- Cookie attributes: `httpOnly`, `Secure`, `SameSite=Lax`, `Path=/`,
  `Max-Age=604800`.

### Enforcement — `proxy.ts` (Next 16's renamed middleware)

- Matcher covers all routes **except** these bypass paths:
  - `/api/cron/*`, `/api/slack/*` — own auth,
  - `/api/auth/*` — the login flow itself,
  - `/login` — the login page,
  - Next internals / static assets (`/_next/*`, `/favicon.ico`, etc.).
- For a covered request, read + verify the session cookie:
  - **valid** → continue,
  - **invalid/absent** → a page request gets a 302 redirect to `/login`; an
    `/api/*` request gets `401 { "error": "unauthenticated" }`.
- HMAC verification uses **Web Crypto** (`crypto.subtle`) so it runs in the edge
  middleware runtime with no Node-only imports.

## Modules

| File | Role | Notes |
|------|------|-------|
| `lib/auth.ts` | **pure, unit-tested** | `signSession`, `verifySession` (constant-time), `decodeIdToken`, `isAllowed`. No `server-only` (CLI-safe). |
| `lib/allowedUsers.ts` | data | Seeded with the two approver ids; shaped like `lib/approvers.ts`. |
| `lib/slackOidc.ts` | `server-only` | `buildAuthorizeUrl`, `exchangeCode`. Reads `SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET`. Token never reaches the browser. |
| `proxy.ts` | enforcement | Next 16's renamed middleware. Edge runtime; Web Crypto HMAC verify; bypass matcher. |
| `app/login/page.tsx` | UI | Single Slack button; `denied` state. |
| `app/api/auth/login/route.ts` | route | state/nonce + redirect to Slack. |
| `app/api/auth/callback/route.ts` | route | code exchange, claim validation, allowlist check, session mint. |
| `app/api/auth/logout/route.ts` | route | clears session cookie. |
| `scripts/access.ts` | CLI | the second interface (below). |

The allowlist is a separate file from `lib/approvers.ts` even though it is
seeded with the same two ids: "can log in" and "can override a verdict" are
distinct authorizations that may diverge.

## CLI (second interface — non-negotiable per CLAUDE.md)

`npm run access -- <subcommand>` (`scripts/access.ts`, run with
`--conditions=react-server` like the other CLIs so any `server-only` import
resolves to its empty module):

- `list` — print the allowlist (`userId`, `name`) as JSON; `--format table` for a
  human view.
- `verify <cookie-value>` — decode + validate a session cookie value and print
  `{ userId, name, valid, expired }`.

Both share `lib/auth.ts` / `lib/allowedUsers.ts` — identical code path to the web.

## Environment variables (added to `.env.example`)

- `SLACK_CLIENT_ID` — Slack app OAuth client id.
- `SLACK_CLIENT_SECRET` — Slack app OAuth client secret (server-only).
- `AUTH_SECRET` — random ≥32 bytes; HMAC key for the session + state/nonce cookies.
- `AUTH_BASE_URL` — public base URL used to build `redirect_uri` (e.g.
  `http://localhost:3003` locally, the Vercel URL in prod).

Slack app setup (one-time, outside code): add the **Sign in with Slack** /
OpenID Connect scopes (`openid`, `email`, `profile`) and register the redirect
URL `<AUTH_BASE_URL>/api/auth/callback` under OAuth & Permissions.

## Testing

`lib/auth.test.ts` (Vitest):

- `signSession` → `verifySession` round-trips and returns the payload.
- A tampered cookie (flipped byte in payload or signature) → `verifySession`
  rejects.
- An expired payload → `verifySession` reports expired.
- `isAllowed` returns true for a seeded id, false for an unknown id.
- `decodeIdToken` extracts `https://slack.com/user_id` + name and validates
  `aud`/`nonce`/`exp` (rejects wrong `aud`, wrong `nonce`, expired).

## Rollout

1. Land the code (gate is active as soon as `proxy.ts` ships).
2. Set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `AUTH_SECRET`, `AUTH_BASE_URL`
   in Vercel + local `.env`.
3. Configure the Slack app's OIDC scopes + redirect URL.
4. Verify: the two approvers can log in; a non-allowlisted workspace member is
   denied; logout returns to `/login`; cron + slack-events endpoints still work
   without a session.
