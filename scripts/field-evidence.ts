/**
 * CLI twin of the verdict-thread reply handler (pilot evidence autonomy) —
 * DRY-RUN BY DEFAULT.
 *   npm run field-evidence -- --thread <channelId:ts | permalink> --reply "<text>" [--as <userId|name>]        # classify + decide, print
 *   npm run field-evidence -- --thread … --reply "…" --write                                                  # perform (verify/escalate/chat/apply)
 *   npm run field-evidence -- --list --start YYYY-MM-DD --end YYYY-MM-DD                                      # audit (mirrors GET /api/evidence)
 * Needs ANTHROPIC_API_KEY (+ SLACK_TOKEN, VIMEO_TOKEN, POSTGRES_URL for --write). Runs under --conditions=react-server.
 */
import { parseThreadRef } from "../lib/agent/threadContext";
import { findPublishedByTs } from "../lib/published";
import { findAskByTs } from "../lib/asks";
import { readActiveProposals, readProposalsInWindow } from "../lib/proposals";
import { readEvidenceEventsInWindow } from "../lib/evidenceEvents";
import { classifyThreadReply } from "../lib/instructionClassify";
import { extractHints } from "../lib/threadReplyHints";
import { decideThreadReply, publishedStatusHint } from "../lib/threadReplyDecide";
import { applyThreadReply, targetEntry, type ReplyTarget } from "../lib/applyThreadReply";
import { runDeferredWork } from "../lib/threadReplyWork";
import { computeVerdicts } from "../lib/computeVerdicts";
import { permalinkFor } from "../lib/slack";
import { TRACKED_CHANNELS } from "../lib/slackChannels";
import { reportKey } from "../lib/fieldDayVerdict";
import { parseArgs, resolveActor } from "./fieldEvidenceReport";

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* ambient env */ }
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    if (!args.start || !args.end) throw new Error("--list needs --start and --end");
    const [events, proposals] = await Promise.all([readEvidenceEventsInWindow(args.start, args.end), readProposalsInWindow(args.start, args.end)]);
    process.stdout.write(JSON.stringify({ period: { start: args.start, end: args.end }, events, pilotProposals: proposals.filter((p) => p.origin === "pilot") }, null, 2) + "\n");
    return;
  }
  if (!args.thread || !args.reply) throw new Error('Usage: --thread <channelId:ts | permalink> --reply "<text>" [--as <userId|name>] [--write]');
  const ref = parseThreadRef(args.thread);
  if (!ref) throw new Error(`--thread: cannot parse "${args.thread}"`);
  const pub = await findPublishedByTs(ref.threadTs);
  const ask = pub ? null : await findAskByTs(ref.threadTs);
  if (!pub && !ask) throw new Error(`thread ${ref.threadTs} is neither a published verdict nor a bot question`);
  const target: ReplyTarget = pub ? { kind: "verdict", entry: pub.entry, period: pub.period } : { kind: "ask", record: ask!.record, period: ask!.period };
  const actor = resolveActor(args.as);
  const entry = targetEntry(target);
  const replyTs = `cli-${Date.now()}`;
  const replyPermalink = permalinkFor(ref.channelId, ref.threadTs);

  if (!args.write) {
    const pending = await readActiveProposals(entry.ts);
    const datasetsId = TRACKED_CHANNELS.find((c) => c.name === "datasets")?.id ?? "";
    const hints = extractHints(args.reply, datasetsId);
    const c = await classifyThreadReply(entry.text, args.reply, pending.length ? pending.map((p) => p.summaryUk).join("; ") : null, actor.role, hints);
    const action = decideThreadReply(c, actor.role, pending.length > 0, publishedStatusHint(entry.text));
    process.stdout.write(JSON.stringify({ target: { kind: target.kind, date: entry.date, reportTs: entry.reportTs, channel: entry.channel }, actor, hints, classification: c, action }, null, 2) + "\n");
    if (action.type === "verify") {
      // Read-only preview of the recompute (no write, no Slack): what the fresh status would be.
      const report = await computeVerdicts(target.period, { onLog: (m) => process.stderr.write(m + "\n") });
      const fresh = report.days.find((d) => reportKey(d.date, d.reportTs) === reportKey(entry.date, entry.reportTs)) ?? report.days.find((d) => d.date === entry.date);
      process.stdout.write(`fresh status (dry-run, not persisted): ${fresh?.status ?? "not found"} — video ${fresh?.videoMinutes ?? "?"} min, dataset ${fresh?.datasetStatus ?? "?"}\n`);
    }
    process.stdout.write("(dry-run — pass --write to perform)\n");
    return;
  }

  const result = await applyThreadReply({ target, replyText: args.reply, userId: actor.userId, userName: actor.userName, role: actor.role, replyTs, replyPermalink, trigger: "cli" });
  if (result.handled === "deferred") {
    const r = await runDeferredWork(result.work, { onLog: (m) => process.stderr.write(m + "\n") });
    process.stdout.write(JSON.stringify({ handled: result.work.kind, ...r }, null, 2) + "\n");
  } else {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }
}

main().catch((err) => { process.stderr.write(`field-evidence: ${err instanceof Error ? err.message : String(err)}\n`); process.exit(1); });
