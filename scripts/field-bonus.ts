/**
 * CLI: recompute per-person field bonuses for a window.
 * Usage: npm run field-bonus -- --start 2026-05-01 --end 2026-05-31 [--format table] [--write]
 * Defaults to the current Europe/Kyiv month. Runs under --conditions=react-server.
 */
import { computeBonusReport, todayInFieldTz } from "../lib/computeBonuses";
import { parseArgs, resolvePeriod, formatTable } from "./fieldBonusReport";

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* ambient env */ }
  const args = parseArgs(process.argv.slice(2));
  const period = resolvePeriod(args, todayInFieldTz());
  const report = await computeBonusReport(period, { write: args.write, onLog: (m) => process.stderr.write(`${m}\n`) });
  if (args.notify) {
    const { readReportJson, periodKey } = await import("../lib/reports");
    const { readPublished } = await import("../lib/published");
    const { readNotified, writeNotified, recordThread, recordDm } = await import("../lib/bonusNotified");
    const { listUsers, openDm, postMessage } = await import("../lib/slack");
    const { bonusThreadKey, bonusDmKey } = await import("../lib/outboundKeys");
    const { matchSlackId } = await import("../lib/fieldSlackIds");
    const { TRACKED_CHANNELS } = await import("../lib/slackChannels");
    const { formatThreadBreakdown, formatDm, formatNoBonusNote } = await import("../lib/bonusNotify");
    const { buildNotifyPlan, formatNotifyDryRun } = await import("./fieldBonusReport");

    const key = periodKey(period);
    const verdict = await readReportJson<{ days: { date: string; status: string }[] }>("field-verdict", key);
    if (!verdict) { process.stderr.write(`field-bonus: no field-verdict report for ${key} — run field-verdict --write first.\n`); process.exit(1); }
    const verdictByDate = new Map(verdict.days.map((d) => [d.date, d.status as import("../lib/fieldDayVerdict").VerdictStatus]));

    const published = await readPublished(period);
    const publishedDates = new Set(Object.keys(published));

    // Resolve each roster name once against the live directory.
    const users = await listUsers();
    const names = [...new Set(report.days.flatMap((d) => d.roster))];
    const slackIdByName = new Map(names.map((n) => [n, matchSlackId(n, users)] as const));

    let log = await readNotified(period);
    const plan = buildNotifyPlan({ days: report.days, verdictByDate, publishedDates, slackIdByName, log });

    if (!args.publish) { console.log(formatNotifyDryRun(plan, args.channel)); return; }

    if (!args.channel) { process.stderr.write("field-bonus: --notify --publish requires --channel <name>.\n"); process.exit(1); }
    const channel = TRACKED_CHANNELS.find((c) => c.name === args.channel);
    if (!channel) { process.stderr.write(`field-bonus: unknown channel "${args.channel}".\n`); process.exit(1); }

    for (const item of plan) {
      if (!item.published) { process.stderr.write(`field-bonus: ${item.date} not published yet — skipping thread+DMs.\n`); continue; }
      const rootTs = published[item.date].ts;
      if (item.threadPending) {
        const text = item.earned ? formatThreadBreakdown(item.date, item.people) : formatNoBonusNote(item.date, item.reason);
        const ts = await postMessage(channel.id, text, {
          key: bonusThreadKey(item.date),
          feature: "bonus",
          channel: channel.name,
          trigger: "cli",
        }, rootTs);
        log = recordThread(log, item.date, ts);
        await writeNotified(period, log);
        process.stderr.write(`field-bonus: posted ${item.earned ? "breakdown" : "no-bonus note"} for ${item.date}\n`);
      }
      for (const t of item.pendingDms) {
        if (t.slackId === null) continue;
        const dm = await openDm(t.slackId);
        const ts = await postMessage(dm, formatDm(item.date, t.amount), {
          key: bonusDmKey(item.date, t.slackId),
          feature: "bonus",
          channel: `dm:${t.slackId}`,
          trigger: "cli",
        });
        log = recordDm(log, item.date, t.slackId, ts, t.amount.total);
        await writeNotified(period, log);
        process.stderr.write(`field-bonus: DMed ${t.name} for ${item.date} (${t.amount.total} грн)\n`);
      }
      for (const n of item.unmatched) process.stderr.write(`field-bonus: no Slack id for ${n} on ${item.date} — DM skipped.\n`);
    }
    process.stderr.write("field-bonus: notify done.\n");
    return;
  }
  if (args.sheet) {
    const { parseSheetTotals, diffAgainstSheet } = await import("../lib/fieldBonusDiff");
    const { readFileSync } = await import("node:fs");
    const diffs = diffAgainstSheet(report, parseSheetTotals(readFileSync(args.sheet, "utf8")));
    process.stderr.write(diffs.length ? `field-bonus: ${diffs.length} divergence(s) vs sheet:\n${diffs.map((d) => `  ${d.name}.${d.field}: ours=${d.ours} sheet=${d.theirs}`).join("\n")}\n` : "field-bonus: matches sheet exactly\n");
  }
  if (args.format === "table") console.log(formatTable(report));
  else console.log(JSON.stringify(report, null, 2));
}

main().catch((e: unknown) => {
  process.stderr.write(`field-bonus: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
