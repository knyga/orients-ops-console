/**
 * CLI: propose people-registry entries by reconciling live Slack users.list with
 * committed Jira/GitHub reports and the roster. PRINTS proposals only — never
 * writes lib/people.ts (a human reviews and pastes). Read the warning in output.
 *
 * Usage: npm run people:scaffold -- [--period YYYY-MM]
 * Runs under --conditions=react-server (lib/slack imports server-only).
 */
import { listUsers } from "../lib/slack";
import { readReportJson } from "../lib/reports";
import { SEED_ALIASES } from "../lib/fieldRoster";
import { proposeMatches, formatProposals, type Candidate } from "../lib/peopleScaffold";

function currentKyivMonthKey(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date()).slice(0, 7);
}

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* ambient env */ }
  const periodArg = process.argv.indexOf("--period");
  const key = periodArg >= 0 ? process.argv[periodArg + 1] : currentKyivMonthKey();

  const candidates: Candidate[] = [];

  // Slack directory (live).
  const users = await listUsers(); // [{ id, name }]
  for (const u of users) candidates.push({ source: "slack", externalId: u.id, displayName: u.name });

  // Committed Jira rows.
  const jira = await readReportJson<{ rows: { accountId: string | null; displayName: string }[] }>("jira", key);
  for (const r of jira?.rows ?? []) if (r.accountId) candidates.push({ source: "jira", externalId: r.accountId, displayName: r.displayName });

  // Committed GitHub contributors.
  const gh = await readReportJson<{ contributors: { login: string; displayName: string }[] }>("github", key);
  for (const c of gh?.contributors ?? []) candidates.push({ source: "github", externalId: c.login, displayName: c.displayName });

  // Roster seed initials.
  for (const [initial, name] of Object.entries(SEED_ALIASES)) candidates.push({ source: "roster", externalId: initial, displayName: name });

  console.log(formatProposals(proposeMatches(candidates)));
}

main().catch((err) => { console.error(err); process.exit(1); });
