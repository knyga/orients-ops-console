import { NextResponse } from "next/server";
import { fetchResolvedIssues, JiraError } from "@/lib/jira";
import { aggregateByUser, sprintChurn } from "@/lib/jiraStats";
import { listPeriods, parsePeriodKey, readReportJson } from "@/lib/reports";

// Token + Jira calls live only on the server; never statically cache.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FEATURE = "jira";

/**
 * GET /api/jira — hybrid read path:
 *   ?periods=1            → { periods } the committed period keys (newest first)
 *   ?period=<key>         → the committed lossless report JSON
 *                           ({ rows, totals, sprintChurn, summaries? }), or 404
 *   ?start=&end=[&refresh]→ live fetch from Jira (the original behavior; the
 *                           only network path)
 *
 * Committing artifacts is the CLI's job (`npm run jira -- --write`); this route
 * only reads them.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  if (searchParams.get("periods")) {
    return NextResponse.json({ periods: await listPeriods(FEATURE) });
  }

  const period = searchParams.get("period");
  if (period) {
    if (!parsePeriodKey(period)) {
      return NextResponse.json(
        { error: "`period` must be YYYY-MM or YYYY-MM-DD_YYYY-MM-DD." },
        { status: 400 },
      );
    }
    const report = await readReportJson(FEATURE, period);
    if (!report) {
      return NextResponse.json(
        { error: `No committed report for ${period}.` },
        { status: 404 },
      );
    }
    return NextResponse.json(report);
  }

  // Live mode: ?start=&end= (with optional ?refresh=1).
  const start = searchParams.get("start");
  const end = searchParams.get("end");

  if (!start || !end) {
    return NextResponse.json(
      { error: "Provide `period`, `periods`, or both `start` and `end`." },
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
