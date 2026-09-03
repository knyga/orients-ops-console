/**
 * CLI: post a compact Ukrainian per-day summary of a period's flight days to a
 * tracked channel (one line per day: crew, window, airborne, drones, status,
 * approver, gate exclusions, links). Reads the committed field-verdict,
 * field-bonus and field-qa reports (run `field-verdict --write` and
 * `field-bonus --write` first). Never mentions money.
 *
 *   npm run field-summary -- --start 2026-08-01 --end 2026-08-31                       # DRY-RUN: prints the exact text
 *   npm run field-summary -- --start 2026-08-01 --end 2026-08-31 --channel field-qa --publish
 *
 * DRY-RUN by default. `--publish` requires `--channel <name>`. Long text is
 * ONE short anchor in the channel (header, status counts, legend) + the per-day
 * lines as thread replies packed under Slack's msg_too_long cap. Idempotent per (period, Kyiv day, chunk) via outbound keys.
 * Runs under `--conditions=react-server` so the server-only imports resolve.
 */
import { FIELD_TIMEZONE } from "../lib/reconcile";
import { readReportJson, periodKey } from "../lib/reports";
import { readPublished } from "../lib/published";
import { reportKey, type DayVerdict } from "../lib/fieldDayVerdict";
import type { DayBonus } from "../lib/fieldBonus";
import { TRACKED_CHANNELS } from "../lib/slackChannels";
import { permalinkFor, postMessage } from "../lib/slack";
import { buildMonthSummary, type SummaryDay } from "../lib/fieldMonthSummary";
import { parseArgs, resolvePeriod, type Period } from "./fieldPublishReport";

interface FieldQaDay {
  date: string;
  droneReport?: { name: string; isPerson: boolean; count: number }[];
}

function todayInFieldTz(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: FIELD_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function approverFromReasons(reasons: string[]): string | null {
  for (const r of reasons) {
    const m = /^(?:exception|rejected) \(([^)]+)\):/.exec(r);
    if (m) return m[1];
  }
  return null;
}

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* rely on ambient env */ }
  const args = parseArgs(process.argv.slice(2));
  const today = todayInFieldTz();
  const period: Period = resolvePeriod(args, today);
  const key = periodKey(period);

  const verdict = await readReportJson<{ days: DayVerdict[] }>("field-verdict", key);
  const bonus = await readReportJson<{ days: DayBonus[] }>("field-bonus", key);
  const fieldQa = await readReportJson<{ days: FieldQaDay[] }>("field-qa", key);
  if (!verdict || !bonus) {
    process.stderr.write(`field-summary: need committed field-verdict + field-bonus for ${key} — run both with --write first.\n`);
    process.exit(1);
  }
  const fieldQaChannel = TRACKED_CHANNELS.find((c) => c.name === "field-qa");
  if (!fieldQaChannel) throw new Error("field-summary: #field-qa is not a tracked channel");
  const published = await readPublished(period);
  const qaByDate = new Map((fieldQa?.days ?? []).map((d) => [d.date, d]));
  const bonusByKey = new Map(bonus.days.map((d) => [reportKey(d.date, d.reportTs), d]));

  const days: SummaryDay[] = verdict.days.map((v) => {
    const b = bonusByKey.get(reportKey(v.date, v.reportTs));
    const qa = qaByDate.get(v.date);
    const pub = published[reportKey(v.date, v.reportTs)] ?? published[v.date];
    const paid = new Set(b?.paidRoster ?? v.roster);
    return {
      date: v.date,
      roster: v.roster,
      deployWindow: v.deployWindow ?? null,
      deployMin: v.deployMin ?? null,
      airborneMinutes: v.airborneMinutes,
      airborneReported: v.airborneReported !== false,
      videoMinutes: v.videoMinutes,
      status: v.status,
      early: b?.early ?? false,
      weekend: b?.weekend ?? false,
      droneCounts: (qa?.droneReport ?? []).filter((e) => e.isPerson).map((e) => ({ name: e.name, count: e.count })),
      droneReportKnown: Array.isArray(qa?.droneReport),
      gateExcluded: v.roster.filter((n) => !paid.has(n)),
      approver: approverFromReasons(v.reasons),
      reasons: v.reasons,
      hasZvit: v.hasZvit !== false,
      verdictUrl: pub ? permalinkFor(fieldQaChannel.id, pub.ts) : null,
      zvitUrl: v.reportTs ? permalinkFor(fieldQaChannel.id, v.reportTs) : null,
    };
  });

  const { anchor, details } = buildMonthSummary(period, today, days);

  if (!args.publish) {
    process.stdout.write(
      `DRY RUN — would post 1 anchor + ${details.length} thread repl${details.length === 1 ? "y" : "ies"} [${period.start} … ${period.end}]\n\n` +
        `=== ANCHOR ===\n${anchor}\n\n` +
        details.map((d, i) => `=== THREAD ${i + 1}/${details.length} ===\n${d}`).join("\n\n") +
        `\n\nNo messages were sent. Re-run with --publish --channel <name>.\n`,
    );
    return;
  }
  if (!args.channel) {
    process.stderr.write("field-summary: --publish requires --channel <name>.\n");
    process.exit(1);
  }
  const channel = TRACKED_CHANNELS.find((c) => c.name === args.channel);
  if (!channel) {
    process.stderr.write(`field-summary: unknown channel "${args.channel}".\n`);
    process.exit(1);
  }
  const meta = (suffix: string) => ({ key: `field-summary:${key}:${today}:${suffix}`, feature: "field-summary", channel: channel.name, trigger: "cli" as const });
  const anchorTs = await postMessage(channel.id, anchor, meta("anchor"));
  process.stderr.write(`field-summary: posted anchor to #${channel.name} (ts ${anchorTs})\n`);
  for (const [i, d] of details.entries()) {
    const ts = await postMessage(channel.id, d, meta(`t${i + 1}`), anchorTs);
    process.stderr.write(`field-summary: posted thread reply ${i + 1}/${details.length} (ts ${ts})\n`);
  }
}

main().catch((e) => {
  process.stderr.write(`field-summary: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
