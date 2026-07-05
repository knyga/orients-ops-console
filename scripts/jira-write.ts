/**
 * CLI: create a Jira ticket for a person, applying the Mr-Lab routing rule, or
 * move an issue into the next sprint.
 *
 * Usage:
 *   npm run jira-write -- create --for "<person>" --summary "<text>" [--desc "<text>"] [--yes]
 *   npm run jira-write -- sprint --key ATP-1714 [--yes]
 *
 * DRY-RUN by default: prints the resolved plan and exits without touching Jira.
 * `--yes` performs the write. `sprint` resolves "next" as the active sprint's
 * number + 1 on the board (lib/sprintPlan.ts), creating the sprint if missing —
 * the same proposal the Slack agent's jira_add_to_next_sprint tool produces.
 *
 * Runs only under Node with `--conditions=react-server` (see package.json) so the
 * `server-only` import in ../lib/jira resolves to its empty module. Needs
 * JIRA_* env; JIRA_DEFAULT_PROJECT + JIRA_MRLAB_ACCOUNT_ID + JIRA_BOARD_ID
 * override the hardcoded defaults.
 */
import { personByQuery } from "../lib/people";
import { routeIssue, routingConfigFromEnv, describeAssignee } from "../lib/jiraRouting";
import { createIssue } from "../lib/jira";
import { jiraNextSprintProposal } from "../lib/agent/tools/jira";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function sprintCmd(): Promise<void> {
  const key = flag("key");
  if (!key) {
    console.error("--key is required, e.g. --key ATP-1714");
    process.exit(1);
  }
  const proposal = await jiraNextSprintProposal({ key });
  console.log(proposal.echoUk);
  if (!has("yes")) {
    console.log("DRY-RUN — nothing changed. Re-run with --yes to apply.");
    return;
  }
  console.log(await proposal.apply());
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "sprint") return sprintCmd();
  if (cmd !== "create") {
    console.error(
      'Usage: npm run jira-write -- create --for "<person>" --summary "<text>" [--desc "<text>"] [--yes]\n' +
        "       npm run jira-write -- sprint --key <ISSUE-KEY> [--yes]",
    );
    process.exit(1);
  }
  const forQuery = flag("for");
  const summary = flag("summary");
  const desc = flag("desc") ?? "";
  if (!forQuery || !summary) {
    console.error("Both --for and --summary are required.");
    process.exit(1);
  }

  const resolved = personByQuery(forQuery);
  if ("unknown" in resolved) {
    console.error(`Unknown person: ${forQuery}`);
    process.exit(1);
  }
  if ("ambiguous" in resolved) {
    console.error(`Ambiguous "${forQuery}": ${resolved.ambiguous.map((p) => p.name).join(", ")}`);
    process.exit(1);
  }
  const person = resolved.person;

  const routing = routeIssue(person, routingConfigFromEnv());
  const description = routing.assignInDescription
    ? `Виконавець: ${person.name}\n\n${desc}`.trim()
    : desc;

  const plan = {
    project: routing.projectKey,
    assignee: describeAssignee(person, routing),
    summary,
    description,
  };

  if (!has("yes")) {
    console.log("DRY-RUN — would create:");
    console.log(JSON.stringify(plan, null, 2));
    console.log("Re-run with --yes to create.");
    return;
  }

  const created = await createIssue({
    projectKey: routing.projectKey,
    summary,
    description,
    assigneeAccountId: routing.jiraAccountId,
  });
  console.log(JSON.stringify(created, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
