/**
 * CLI: fetch GitHub dev-reporting stats for a date window and print them.
 *
 * Usage: npm run github -- --start 2026-05-01 --end 2026-05-31 [--format table]
 *        npm run github -- --start 2026-05-01 --end 2026-05-31 --write [--summarize]
 * Defaults to the current calendar month (UTC) when bounds are omitted.
 *
 * `--write` persists the period as committed artifacts under reports/github/: a
 * lossless `<period>.json` (the web's render source) and a flat `<period>.csv`
 * human record. `--summarize` adds a per-contributor occupation summary column
 * (via Claude, claude-opus-4-8); it implies `--write`. `--summaries-file <path>`
 * supplies those summaries from a JSON file (contributor key → text) instead of
 * calling Claude — the path used when Claude Code sonnet subagents generate the
 * prose; it also implies `--write`. `--dump-work` prints per-contributor work
 * items (PR titles + commit headlines) as JSON and exits — the subagents' input.
 *
 * Runs only under Node with `--conditions=react-server` (see package.json) so
 * the `server-only` import in ../lib/github resolves to its empty module.
 */
import { readFileSync } from "node:fs";
import { fetchOrgActivityForPeriod } from "../lib/github";
import { summarize, workByContributor } from "../lib/devStats";
import { summarizeOccupations } from "../lib/summarize";
import { writeReport } from "../lib/reports";
import { formatTable, parseArgs, resolvePeriod, toCsv } from "./githubStats";

/** Today's date (YYYY-MM-DD) in UTC. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Load externally-supplied per-contributor summaries from a JSON file (a plain
 * object of contributor key → summary text), as the same Map shape
 * summarizeOccupations yields, so toCsv consumes it identically.
 */
function loadSummariesFile(path: string): Map<string | null, string> {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  return new Map<string | null, string>(Object.entries(raw));
}

async function main(): Promise<void> {
  // Load .env (where GH_ACCESS_TOKEN lives) if present; ignore if absent.
  try {
    process.loadEnvFile();
  } catch {
    // No .env file — rely on the ambient environment.
  }

  const args = parseArgs(process.argv.slice(2));
  const period = resolvePeriod(args, todayUtc());

  const activity = await fetchOrgActivityForPeriod(period.start, period.end);

  // --dump-work: emit per-contributor work items for an external summarizer
  // (e.g. Claude Code sonnet subagents) and exit. No Claude, no CSV.
  if (args.dumpWork) {
    console.log(JSON.stringify(workByContributor(activity), null, 2));
    return;
  }

  const summary = summarize(activity);

  // A populated org with zero commits AND zero PRs almost always means the token
  // lacks repo/org read scope, not a genuinely empty period — warn, don't mislead.
  if (
    summary.totals.repos > 0 &&
    summary.totals.commits === 0 &&
    summary.totals.prsOpened === 0
  ) {
    process.stderr.write(
      "github: warning — all contributors are zero across active repos. " +
        "This usually means GH_ACCESS_TOKEN lacks repo/org read scope, not an empty period.\n",
    );
  }

  // Summaries come either from an external file (--summaries-file) or Claude
  // (--summarize). Keyed by the contributor's stable key (login:…/name:…).
  let summaries: Map<string | null, string> | undefined;
  if (args.summariesFile) {
    summaries = loadSummariesFile(args.summariesFile);
    process.stderr.write(
      `github: loaded ${summaries.size} summaries from ${args.summariesFile}\n`,
    );
  } else if (args.summarize) {
    process.stderr.write(
      `github: summarizing ${summary.contributors.length} contributors via Claude…\n`,
    );
    summaries = await summarizeOccupations(workByContributor(activity));
  }

  if (args.format === "table") {
    console.log(formatTable(summary));
  } else {
    console.log(JSON.stringify(summary, null, 2));
  }

  // --summarize / --summaries-file imply --write (so summaries are persisted).
  if (args.write || args.summarize || args.summariesFile) {
    const body =
      summaries && summaries.size > 0
        ? {
            ...summary,
            summaries: Object.fromEntries(
              [...summaries].filter((entry): entry is [string, string] => entry[0] !== null),
            ),
          }
        : summary;
    const { jsonPath, csvPath } = writeReport("github", period, {
      json: JSON.stringify(body, null, 2),
      csv: toCsv(summary, summaries),
    });
    process.stderr.write(
      `github: wrote ${jsonPath} and ${csvPath} (${summary.totals.contributors} contributors, ${summary.totals.commits} commits${summaries ? ", with summaries" : ""})\n`,
    );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`github: ${message}\n`);
  process.exit(1);
});
