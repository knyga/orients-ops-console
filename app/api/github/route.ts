import { NextResponse } from "next/server";
import { fetchOrgActivityForPeriod, GitHubError } from "@/lib/github";

// Token + GitHub calls live only on the server; never statically cache.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/github?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * The browser calls this route (never GitHub directly). We fetch the period's
 * org activity server-side using GH_ACCESS_TOKEN and return it as JSON.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const start = searchParams.get("start");
  const end = searchParams.get("end");

  if (!start || !end) {
    return NextResponse.json(
      { error: "Both `start` and `end` query params are required." },
      { status: 400 },
    );
  }
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    return NextResponse.json(
      { error: "`start` and `end` must be YYYY-MM-DD dates." },
      { status: 400 },
    );
  }
  if (start > end) {
    return NextResponse.json(
      { error: "`start` must be on or before `end`." },
      { status: 400 },
    );
  }

  try {
    const activity = await fetchOrgActivityForPeriod(start, end);
    return NextResponse.json({ activity });
  } catch (error) {
    if (error instanceof GitHubError) {
      // Missing token / upstream failures: 502 for upstream, 500 for config.
      const status = error.status ? 502 : 500;
      return NextResponse.json({ error: error.message }, { status });
    }
    const message =
      error instanceof Error ? error.message : "Unexpected server error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
