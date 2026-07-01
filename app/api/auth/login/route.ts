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
