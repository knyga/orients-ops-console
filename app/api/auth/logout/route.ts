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
