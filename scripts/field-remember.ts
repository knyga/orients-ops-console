/**
 * CLI: ingest the human replies to the bot's S5 questions and REMEMBER the
 * outcome — DRY-RUN BY DEFAULT. For each ASKED question it reads the threaded
 * replies from the local Slack mirror, classifies each (Claude), and decides the
 * outcome: an accepted-exception explanation is ESCALATED as a pilot-origin
 * proposal for the approvers (never written directly); a data-provided or
 * still-missing reply just advances the ask state (a data-provided answer is
 * verified live by the next verdict recompute, not written here).
 *
 * Usage:
 *   npm run field-remember -- --start 2026-06-01 --end 2026-06-19          # dry-run (classify + print)
 *   npm run field-remember -- --start … --end … --write                   # apply (escalate + advance ask states)
 * Defaults to the current Europe/Kyiv month. Run `npm run slack-sync` first so
 * the threaded replies are mirrored. Classification needs ANTHROPIC_API_KEY.
 *
 * Runs under `--conditions=react-server` so the server-only imports resolve.
 */
import { classifyAnswer } from "../lib/answerClassify";
import { applyAnswerDecision } from "../lib/applyAnswer";
import { readChannelMessages } from "../lib/slackMirror";
import { readAsks } from "../lib/asks";
import { FIELD_TIMEZONE } from "../lib/reconcile";
import { personForSlackId } from "../lib/people";
import {
  decideOutcome,
  parseArgs,
  resolvePeriod,
  type ClassifiedReply,
  type Period,
} from "./fieldRememberReport";

function todayInFieldTz(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FIELD_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* rely on ambient env */ }

  const args = parseArgs(process.argv.slice(2));
  const today = todayInFieldTz();
  const period: Period = resolvePeriod(args, today);

  const log = await readAsks(period);
  const askedKeys = Object.keys(log).filter((k) => log[k].state === "ASKED");
  if (askedKeys.length === 0) {
    process.stderr.write(`field-remember: no ASKED questions for ${period.start}…${period.end} (run \`npm run field-ask\` first).\n`);
    return;
  }

  let escalated = 0;
  let transitions = 0;

  // Replies arrive after the flight period (the bot asks "now", people answer
  // later), so read the channel through today — not the flight period.
  const readWindow = { start: period.start, end: today > period.end ? today : period.end };

  for (const key of askedKeys) {
    const record = log[key];
    // Threaded replies to the bot's question (exclude the question itself + tombstones).
    const replies = (await readChannelMessages(record.channel, readWindow)).filter(
      (m) => m.thread_ts === record.askedTs && m.ts !== record.askedTs && !m.deleted,
    );

    if (replies.length === 0) {
      console.log(`• ${key} — asked in #${record.channel}, no replies yet.`);
      continue;
    }

    const classified: ClassifiedReply[] = [];
    for (const r of replies) {
      const classification = await classifyAnswer(record.question, r.text);
      classified.push({ classification, permalink: r.permalink });
      console.log(`• ${key} ← "${r.text.slice(0, 80)}" → ${classification.type} (resolved=${classification.resolved})`);
    }

    const outcome = decideOutcome(classified);
    if (!outcome) continue;

    console.log(
      `• ${record.date} ${record.gapType} ⇒ ${
        outcome.escalate ? "would ESCALATE to approvers (pilot-origin proposal)" : `state → ${outcome.state}`
      }: ${outcome.note}`,
    );

    if (args.write) {
      const deciding = replies.find((r) => r.permalink === outcome.evidencePermalink) ?? replies[replies.length - 1];
      // The answer effect (escalation + ask-state advance) is shared with the
      // events webhook path — one source of truth in lib/applyAnswer.
      await applyAnswerDecision({
        record,
        period,
        outcome,
        replyTs: deciding.ts,
        userId: deciding.authorId,
        userName: personForSlackId(deciding.authorId)?.name ?? deciding.author,
        trigger: "cli",
      });
      if (outcome.escalate) escalated += 1;
      transitions += 1;
    }
  }

  if (args.write) {
    process.stderr.write(`field-remember: applied ${transitions} state change(s), escalated ${escalated} to approvers.\n`);
  } else {
    process.stderr.write("field-remember: DRY RUN — nothing was escalated or written. Re-run with --write to apply.\n");
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`field-remember: ${message}\n`);
  process.exit(1);
});
