// app/api/who/route.ts
import { NextResponse } from "next/server";
import { readChannelMessages } from "@/lib/slackMirror";
import { TRACKED_CHANNELS } from "@/lib/slackChannels";
import { readReportJson } from "@/lib/reports";
import { parsePeriodKey } from "@/lib/period";
import { PEOPLE, personByQuery } from "@/lib/people";
import { buildPersonView, type WhoSources } from "@/lib/who";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/who — committed-only person view:
 *   ?people=1                 → { people } registry display names (for the picker)
 *   ?person=<query>&period=<key> → PersonView JSON (Slack timeline + summaries)
 * No live mode: reads the Slack mirror DB + committed Jira/GitHub/field-bonus.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  if (searchParams.get("people")) {
    return NextResponse.json({ people: PEOPLE.map((p) => p.name) });
  }

  const personQ = searchParams.get("person");
  const periodKeyParam = searchParams.get("period");
  if (!personQ || !periodKeyParam) {
    return NextResponse.json({ error: "Provide `person` and `period`, or `people=1`." }, { status: 400 });
  }
  const period = parsePeriodKey(periodKeyParam);
  if (!period) {
    return NextResponse.json({ error: "`period` must be YYYY-MM or YYYY-MM-DD_YYYY-MM-DD." }, { status: 400 });
  }
  const resolved = personByQuery(personQ);
  if ("unknown" in resolved) {
    return NextResponse.json({ error: `Unknown person "${resolved.unknown}".` }, { status: 404 });
  }
  if ("ambiguous" in resolved) {
    return NextResponse.json({ error: "Ambiguous person.", candidates: resolved.ambiguous.map((p) => p.name) }, { status: 400 });
  }

  const perChannel = await Promise.all(TRACKED_CHANNELS.map((c) => readChannelMessages(c.name, period)));
  const [jira, github, bonus] = await Promise.all([
    readReportJson<WhoSources["jira"]>("jira", periodKeyParam),
    readReportJson<WhoSources["github"]>("github", periodKeyParam),
    readReportJson<WhoSources["bonus"]>("field-bonus", periodKeyParam),
  ]);
  const view = buildPersonView(resolved.person, period, { messages: perChannel.flat(), jira, github, bonus });
  return NextResponse.json(view);
}
