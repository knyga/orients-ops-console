/**
 * Field-summary write tool for the agent loop: an approver @mentions the bot
 * in #field-qa («опублікуй підсумок польових днів за серпень») and this
 * proposes posting the Ukrainian per-day summary (lib/fieldMonthSummary) —
 * a short anchor + the day lines in its thread. Asked inside an existing
 * thread, it posts into THAT thread instead. Confirm-first like every write;
 * `apply()` goes through the deterministic executor, and the Slack confirm
 * path is approver-gated (lib/proposalGate).
 */
import { assembleSummaryDays } from "@/lib/fieldSummaryPost";
import { countsUk, parseSummaryPeriod, periodLabelUk, summaryCounts } from "@/lib/fieldMonthSummary";
import { applyProposal } from "@/lib/proposalExecutor";
import type { Proposal, ProposeContext, Tool } from "./types";

export async function fieldSummaryPostProposal(
  args: Record<string, unknown>,
  ctx?: ProposeContext,
): Promise<Proposal> {
  if (!ctx?.channelId) {
    throw new Error("публікація підсумку працює лише у Slack-каналі (згадайте бота в #field-qa або в треді).");
  }
  const period = parseSummaryPeriod(args.start, args.end);
  // Live counts at PROPOSE time so the approver confirms against real numbers.
  const days = await assembleSummaryDays(period);
  const counts = summaryCounts(days);
  // Only a turn from INSIDE a thread posts into that thread; a top-level
  // @mention (whose ctx.threadTs is the mention's own ts) gets a fresh anchor.
  const threadTs = ctx.inThread && ctx.threadTs ? ctx.threadTs : null;
  const params: Record<string, unknown> = {
    channelId: ctx.channelId,
    threadTs,
    start: period.start,
    end: period.end,
  };
  const where = threadTs ? "у цьому треді" : `у <#${ctx.channelId}> (анкор + деталі в треді)`;
  return {
    kind: "field_summary_post",
    params,
    echoUk: `📋 Опублікую підсумок польових днів за ${periodLabelUk(period)} — ${countsUk(counts)} — ${where}. Застосувати? (так/ні)`,
    apply: () => applyProposal("field_summary_post", params),
  };
}

export const fieldSummaryTools: Tool[] = [
  {
    name: "field_summary_post",
    description:
      "Post the Ukrainian per-day summary of a period's flight days (crew, deploy window, airborne, video, drone counts, " +
      "✅/⚠️/⛔/⏳ status with approver, drone-gate exclusions, links) to the channel the request came from: a short anchor + " +
      "the day lines in its thread; asked inside a thread, it posts into that thread. Never mentions money. " +
      "Use when asked «опублікуй/надішли підсумок польових днів за <місяць/період>». Confirm-first and approver-only. " +
      "Pass the period as ISO dates: a month name means its first..last day (e.g. «за серпень» → 2026-08-01..2026-08-31).",
    inputSchema: {
      type: "object",
      properties: {
        start: { type: "string", description: "Period start, YYYY-MM-DD (Europe/Kyiv)." },
        end: { type: "string", description: "Period end, YYYY-MM-DD (inclusive)." },
      },
      required: ["start", "end"],
    },
    kind: "write",
    propose: fieldSummaryPostProposal,
  },
];
