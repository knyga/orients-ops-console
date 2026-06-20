/**
 * Shared S6 effect: remember the outcome of a human's reply to one of the bot's
 * S5 questions. SERVER-ONLY (classifies via Claude). One source of truth for the
 * answer effect, called by BOTH the `field-remember` CLI (batch decide →
 * applyAnswerDecision) and the `/api/slack/events` webhook (one reply →
 * applyAnswerReply). Idempotent via the ask state machine.
 */
import "server-only";
import { classifyAnswer } from "./answerClassify";
import { setAskState, writeAsks, type AskRecord } from "./asks";
import { upsertResolution } from "./resolutions";
import type { Period } from "./period";
import { decideOutcome, type Outcome } from "../scripts/fieldRememberReport";

/** The gap key for an ask record (`${gapType}:${date}`) — matches lib/asks keying. */
function gapKeyFor(record: AskRecord): string {
  return `${record.gapType}:${record.date}`;
}

export interface AnswerDecisionArgs {
  record: AskRecord;
  period: Period;
  outcome: Outcome;
}

/**
 * The answer effect: when the outcome is an accepted exception, write it to the
 * resolutions store (so the next verdict flips that day NEEDS_REVIEW →
 * ACCEPTED_EXCEPTION); always advance the ask's state. Persists the single ask
 * record (upsert) so the CLI's batch loop and the webhook share one write path.
 */
export async function applyAnswerDecision(args: AnswerDecisionArgs): Promise<void> {
  const { record, period, outcome } = args;

  if (outcome.writeException) {
    await upsertResolution({
      date: record.date,
      decision: "accepted_exception",
      note: outcome.note,
      source: outcome.evidencePermalink || "slack",
      recordedAt: new Date().toISOString(),
    });
  }

  const key = gapKeyFor(record);
  const updated = setAskState({ [key]: record }, key, outcome.state, outcome.note);
  await writeAsks(period, updated);
}

export interface AnswerReplyArgs {
  record: AskRecord;
  period: Period;
  replyText: string;
  replyPermalink: string;
}

/**
 * Single-reply path for the events webhook: classify one reply to the bot's
 * question and apply the outcome (a reply that resolves nothing is a no-op).
 */
export async function applyAnswerReply(args: AnswerReplyArgs): Promise<void> {
  const classification = await classifyAnswer(args.record.question, args.replyText);
  const outcome = decideOutcome([{ classification, permalink: args.replyPermalink }]);
  if (!outcome) return;
  await applyAnswerDecision({ record: args.record, period: args.period, outcome });
}
