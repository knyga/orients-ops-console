/**
 * CLI: derive per-flight-day crew from the committed field-ops crew-sheet
 * snapshot and record it as roster corrections — DRY-RUN BY DEFAULT.
 *
 * Reads the Drive-synced CSV (`reports/drive/field-ops-crew.csv`, resolved via
 * the `field-ops-crew` manifest source), maps each marked person to a canonical
 * roster name (explicit table in lib/crewSheet), and (with --write) upserts a
 * roster_correction per day (source "field-ops-sheet"). Approver/manual
 * corrections OUTRANK the sheet (lib/rosterCorrection.sheetImportShouldSkip), so
 * a re-import never regresses a confirmed fix.
 *
 * Usage:
 *   npm run field-crew -- --start 2026-06-01 --end 2026-06-30           # dry-run
 *   npm run field-crew -- --start … --end … --write                     # apply
 * Defaults to the current Kyiv month. Run `npm run drive -- pull` first.
 */
import { readFileSync } from "node:fs";
import { parseManifest } from "../lib/driveManifest";
import { crewByDate, parseCsv } from "../lib/crewSheet";
import { applyCrewCorrections } from "../lib/crewImport";
import { FIELD_TIMEZONE } from "../lib/reconcile";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CREW_SOURCE_ID = "field-ops-crew";

function todayInFieldTz(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: FIELD_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function parseArgs(argv: string[]): { start?: string; end?: string; write: boolean } {
  const a: { start?: string; end?: string; write: boolean } = { write: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--start") { a.start = argv[i + 1]; i += 1; }
    else if (argv[i] === "--end") { a.end = argv[i + 1]; i += 1; }
    else if (argv[i] === "--write") { a.write = true; }
  }
  return a;
}

function resolvePeriod(a: { start?: string; end?: string }, today: string): { start: string; end: string } {
  let { start, end } = a;
  if (!start || !end) { start = `${today.slice(0, 7)}-01`; end = today; }
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) throw new Error(`Period bounds must be YYYY-MM-DD: start=${start} end=${end}`);
  return { start, end };
}

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* ambient env */ }

  const args = parseArgs(process.argv.slice(2));
  const period = resolvePeriod(args, todayInFieldTz());

  const manifest = parseManifest(readFileSync("reports/drive/manifest.json", "utf8"));
  const source = manifest.sources.find((s) => s.id === CREW_SOURCE_ID);
  if (!source) throw new Error(`no "${CREW_SOURCE_ID}" source in reports/drive/manifest.json — add it + \`npm run drive -- pull\`.`);

  let csv: string;
  try {
    csv = readFileSync(source.dest, "utf8");
  } catch {
    throw new Error(`${source.dest} not found — run \`npm run drive -- pull --only ${CREW_SOURCE_ID}\` first.`);
  }

  const crew = crewByDate(parseCsv(csv));
  const { applied, kept, days } = await applyCrewCorrections(crew, period, {
    write: args.write,
    onLog: (m) => process.stdout.write(`${m}\n`),
  });

  if (args.write) process.stderr.write(`field-crew: wrote ${applied} day(s), kept ${kept} approver/manual. Re-run \`npm run field-verdict -- --write\` + \`npm run field-bonus\` to reflect.\n`);
  else process.stderr.write(`field-crew: DRY RUN — ${days} day(s) with crew (${kept} protected by an approver/manual correction). Re-run with --write to apply.\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`field-crew: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
