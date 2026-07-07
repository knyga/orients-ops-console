/**
 * CLI: create a Google Calendar meeting (Meet link + real invites) organized by
 * the impersonated GOOGLE_CALENDAR_ORGANIZER account.
 *
 * Usage:
 *   npm run calendar-write -- create --title "<text>" --start "2026-07-08T15:00" \
 *     [--end "2026-07-08T16:00" | --duration 30] --attendees "Тарас,Влад,x@y.com" \
 *     [--desc "<text>"] [--yes]
 *
 * DRY-RUN by default: prints the resolved plan (absolute Kyiv times, resolved
 * attendee emails, organizer) and touches nothing. `--yes` creates the event and
 * prints the Meet + Calendar links. Attendees resolve via the lib/people.ts
 * roster (email field) or raw emails; unknown names fail loudly. No LLM — the
 * same propose/apply path the agent's calendar_create_event tool uses.
 *
 * Runs only under Node with `--conditions=react-server` (see package.json) so
 * the `server-only` import in ../lib/googleCalendar resolves to its empty
 * module. Needs GOOGLE_SERVICE_ACCOUNT_KEY + GOOGLE_CALENDAR_ORGANIZER (+ the
 * one-time domain-wide-delegation grant) for --yes; dry-run needs no env.
 */
import { calendarCreateProposal } from "../lib/agent/tools/calendar";
import { addMinutesIso } from "../lib/calendarEvent";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  if (process.argv[2] !== "create") {
    console.error(
      'Usage: npm run calendar-write -- create --title "<text>" --start "2026-07-08T15:00" ' +
        '[--end "..." | --duration 30] --attendees "Тарас,Влад,x@y.com" [--desc "<text>"] [--yes]',
    );
    process.exit(1);
  }
  const title = flag("title");
  const start = flag("start");
  if (!title || !start) {
    console.error("Both --title and --start are required.");
    process.exit(1);
  }
  const attendees = (flag("attendees") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  let end = flag("end");
  if (!end) {
    const duration = Number(flag("duration") ?? "30");
    if (!Number.isFinite(duration) || duration <= 0) {
      console.error("--duration must be a positive number of minutes.");
      process.exit(1);
    }
    const computed = addMinutesIso(start, duration);
    if (!computed) {
      console.error(`Cannot parse --start "${start}" (expect ISO, e.g. 2026-07-08T15:00).`);
      process.exit(1);
    }
    end = computed;
  }

  const proposal = await calendarCreateProposal({
    title,
    startIso: start,
    endIso: end,
    attendees,
    description: flag("desc") ?? "",
  });
  console.log(proposal.echoUk);
  if (!has("yes")) {
    console.log("DRY-RUN — nothing created, no invites sent. Re-run with --yes to create.");
    return;
  }
  console.log(await proposal.apply());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
