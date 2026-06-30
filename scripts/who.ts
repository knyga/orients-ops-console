// scripts/who.ts
/**
 * CLI: person-centric activity view for a window.
 *
 * Usage: npm run who -- --person <query> --start 2026-06-01 --end 2026-06-30 [--format table]
 *        npm run who -- --unlinked --start 2026-06-01 --end 2026-06-30
 * Defaults to the current Europe/Kyiv calendar month when bounds are omitted.
 *
 * Read-only: the Slack mirror DB + committed Jira/GitHub/field-bonus report JSON.
 * No live fetch, no --write. Runs under Node with --conditions=react-server so
 * server-only-backed imports resolve to their empty module.
 */
import { readChannelMessages } from "../lib/slackMirror";
import { TRACKED_CHANNELS } from "../lib/slackChannels";
import { readReportJson } from "../lib/reports";
import { periodKey } from "../lib/period";
import { PEOPLE, personByQuery } from "../lib/people";
import { buildPersonView, findUnlinked, type WhoSources } from "../lib/who";
import { parseArgs, resolvePeriod, formatTable, formatUnlinkedTable } from "./whoReport";

function todayInFieldTz(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

async function loadSources(period: { start: string; end: string }): Promise<WhoSources> {
  const perChannel = await Promise.all(TRACKED_CHANNELS.map((c) => readChannelMessages(c.name, period)));
  const key = periodKey(period);
  const [jira, github, bonus] = await Promise.all([
    readReportJson<WhoSources["jira"]>("jira", key),
    readReportJson<WhoSources["github"]>("github", key),
    readReportJson<WhoSources["bonus"]>("field-bonus", key),
  ]);
  return { messages: perChannel.flat(), jira, github, bonus };
}

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* rely on ambient env */ }
  const args = parseArgs(process.argv.slice(2));
  const period = resolvePeriod(args, todayInFieldTz());
  const sources = await loadSources(period);

  if (args.unlinked) {
    const report = findUnlinked(sources, PEOPLE);
    if (args.format === "table") console.log(formatUnlinkedTable(report));
    else console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (!args.person) {
    console.error("Provide --person <query> (or --unlinked).");
    process.exit(1);
  }
  const resolved = personByQuery(args.person);
  if ("unknown" in resolved) {
    console.error(`Unknown person "${resolved.unknown}". Known: ${PEOPLE.map((p) => p.name).join(", ")}`);
    process.exit(1);
  }
  if ("ambiguous" in resolved) {
    console.error(`Ambiguous "${args.person}". Matches: ${resolved.ambiguous.map((p) => p.name).join(", ")}`);
    process.exit(1);
  }
  const view = buildPersonView(resolved.person, period, sources);
  if (args.format === "table") console.log(formatTable(view));
  else console.log(JSON.stringify(view, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
