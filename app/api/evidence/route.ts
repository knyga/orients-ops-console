import { NextResponse } from "next/server";
import { parsePeriodKey } from "@/lib/period";
import { readEvidenceEventsInWindow } from "@/lib/evidenceEvents";
import { readProposalsInWindow } from "@/lib/proposals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/evidence?period=<key> — pilot evidence events + pilot-origin proposals (DB-backed, like /api/instructions). */
export async function GET(request: Request) {
  const period = new URL(request.url).searchParams.get("period");
  const parsed = period ? parsePeriodKey(period) : null;
  if (!parsed) return NextResponse.json({ error: "Provide `period` (YYYY-MM or YYYY-MM-DD_YYYY-MM-DD)." }, { status: 400 });
  const [events, proposals] = await Promise.all([readEvidenceEventsInWindow(parsed.start, parsed.end), readProposalsInWindow(parsed.start, parsed.end)]);
  return NextResponse.json({ period: parsed, events, pilotProposals: proposals.filter((p) => p.origin === "pilot") });
}
