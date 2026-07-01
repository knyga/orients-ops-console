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
