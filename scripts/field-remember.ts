/**
 * CLI: ingest the human replies to the bot's S5 questions and REMEMBER the
 * outcome — DRY-RUN BY DEFAULT. For each ASKED question it reads the threaded
 * replies from the local Slack mirror, classifies each (Claude), and decides the
 * outcome: an accepted exception is written to the resolutions store (so the next
 * verdict run flips that day NEEDS_REVIEW → ACCEPTED_EXCEPTION); a data-provided
 * or still-missing reply just advances the ask state.
 *
 * Usage:
 *   npm run field-remember -- --start 2026-06-01 --end 2026-06-19          # dry-run (classify + print)
 *   npm run field-remember -- --start … --end … --write                   # apply (write resolutions + states)
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

  let resolutionsWritten = 0;
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
      `  ⇒ ${args.write ? "applying" : "would apply"}: ask→${outcome.state}` +
        (outcome.writeException ? `, +resolution exception for ${record.date}` : "") +
        ` — ${outcome.note}`,
    );

    if (args.write) {
      // The answer effect (resolution + ask-state advance) is shared with the
      // events webhook — one source of truth in lib/applyAnswer.
      await applyAnswerDecision({ record, period, outcome });
      if (outcome.writeException) resolutionsWritten += 1;
      transitions += 1;
    }
  }

  if (args.write) {
    process.stderr.write(`field-remember: applied ${transitions} state change(s), wrote ${resolutionsWritten} exception(s).\n`);
  } else {
    process.stderr.write("field-remember: DRY RUN — no resolutions or ask states were written. Re-run with --write to apply.\n");
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`field-remember: ${message}\n`);
  process.exit(1);
});
