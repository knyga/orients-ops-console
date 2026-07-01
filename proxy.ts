import { NextResponse, type NextRequest } from "next/server";
import { verifySession } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/authCookies";

/**
 * Auth gate proxy. Every request matched by `config.matcher` (everything except the
 * bypass paths + static assets) must carry a valid session cookie. Pages get a
 * 302 to /login; API routes get 401 JSON. Runs in the edge runtime — verifySession
 * uses Web Crypto only.
 *
 * Bypass (own auth / public): /api/auth/*, /api/cron/*, /api/slack/*, /login.
 */
export async function proxy(request: NextRequest) {
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
  matcher: ["/((?!(?:api/auth|api/cron|api/slack|login)(?:/|$)|_next/static|_next/image|favicon.ico).*)"],
};
