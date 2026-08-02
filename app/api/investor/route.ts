import { NextResponse } from "next/server";
import { listInvestorKeys, readInvestor } from "@/lib/investorStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/investor?periods=1      → { keys: string[] } (newest first)
 * GET /api/investor?period=<key>   → the stored InvestorRecord (404 when absent)
 *
 * Read-only view of the committed weekly investor reports (feature "investor"
 * in the reports table). The web never writes — the CLI/cron is the writer.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  if (searchParams.get("periods")) {
    return NextResponse.json({ keys: await listInvestorKeys() });
  }

  const period = searchParams.get("period");
  if (!period) {
    return NextResponse.json(
      { error: "Provide `period=<start_end>` or `periods=1` to list." },
      { status: 400 },
    );
  }
  const record = await readInvestor(period);
  if (!record) {
    return NextResponse.json({ error: `No investor report "${period}".` }, { status: 404 });
  }
  return NextResponse.json(record);
}
