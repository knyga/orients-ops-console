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
