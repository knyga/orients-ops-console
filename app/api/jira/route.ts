import { NextResponse } from "next/server";
import { fetchResolvedIssues, JiraError } from "@/lib/jira";
import { aggregateByUser, sprintChurn } from "@/lib/jiraStats";

// Token + Jira calls live only on the server; never statically cache.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/jira?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * The browser calls this route (never Jira directly). We fetch the period's
 * resolved issues server-side, aggregate per-user stats + sprint churn, and
 * return them as JSON.
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
    const issues = await fetchResolvedIssues(start, end);
    const { rows, totals } = aggregateByUser(issues);
    return NextResponse.json({ rows, totals, sprintChurn: sprintChurn(issues) });
  } catch (error) {
    if (error instanceof JiraError) {
      // Upstream failures: 502; missing config/token: 500.
      const status = error.status ? 502 : 500;
      return NextResponse.json({ error: error.message }, { status });
    }
    const message =
      error instanceof Error ? error.message : "Unexpected server error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
