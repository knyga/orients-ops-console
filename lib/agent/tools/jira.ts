/**
 * Jira tools for the agent loop. The read tool (jira_search) executes live; the
 * write tools resolve into confirm-first Proposals — the loop never writes. The
 * create proposal applies the Mr-Lab routing rule (lib/jiraRouting.ts), so the
 * echo shows the resolved project and a misroute is caught before creation.
 *
 * Reachable only under server-only conditions (lib/jira.ts). Needs JIRA_* env.
 */
import { searchIssues, listSprints, boardIdFromEnv } from "@/lib/jira";
import { routeIssue, routingConfigFromEnv, describeAssignee } from "@/lib/jiraRouting";
import { personByQuery } from "@/lib/people";
import { planNextSprint, latestNumberedSprint } from "@/lib/sprintPlan";
import { applyProposal } from "@/lib/proposalExecutor";
import type { Proposal, ProposeContext, Tool } from "./types";

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`Missing required "${key}".`);
  return v.trim();
}
function optStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : "";
}

interface NextSprintParams {
  boardId: number;
  sprintId: number | null;
  sprintName: string;
}

/** Resolve "next sprint" against the live board (active sprint's number + 1;
 *  between sprints, the highest-numbered closed sprint anchors). Shared by the
 *  standalone move tool and jira_create's addToNextSprint. */
async function resolveNextSprint(): Promise<{
  params: NextSprintParams;
  create: boolean;
  anchorNoteUk: string;
}> {
  const boardId = boardIdFromEnv();
  const active = await listSprints(boardId, "active");
  const anchor = active.length ? active[0] : latestNumberedSprint(await listSprints(boardId, "closed"));
  if (!anchor) throw new Error(`Board ${boardId} has no active or closed sprint to determine the next one from.`);
  const future = await listSprints(boardId, "future");

  const plan = planNextSprint(anchor.name, future);
  if (!plan) {
    throw new Error(`Sprint "${anchor.name}" has no number to increment — name the target sprint explicitly.`);
  }
  const anchorNoteUk = active.length
    ? `активний — «${anchor.name}»`
    : `активного немає, останній завершений — «${anchor.name}»`;
  return {
    params: { boardId, sprintId: plan.sprintId, sprintName: plan.sprintName },
    create: plan.create,
    anchorNoteUk,
  };
}

/** Resolve {person, summary, description} → a create Proposal with Mr-Lab routing.
 *  A ctx.sourceUrl (the Slack thread the request came from) is appended to the
 *  description here, deterministically — the model never has to relay it. With
 *  addToNextSprint, the sprint is resolved into the SAME proposal so one «так»
 *  covers create + sprint (the loop stops at the first write, so a second
 *  action would otherwise cost the user an extra round-trip). */
export async function jiraCreateProposal(
  args: Record<string, unknown>,
  ctx?: ProposeContext,
): Promise<Proposal> {
  const personQuery = str(args, "person");
  const summary = str(args, "summary");
  const sourceLine = ctx?.sourceUrl ? `\n\nSlack: ${ctx.sourceUrl}` : "";
  // The tool prepends its own «Виконавець:» line; drop the model's copy so the
  // ticket does not start with the line twice.
  const desc = optStr(args, "description").replace(/^Виконавець:[^\n]*\n+/u, "");
  const sprint = args.addToNextSprint === true ? await resolveNextSprint() : null;
  const sprintEcho = sprint
    ? `\nПісля створення додам до наступного спринту «${sprint.params.sprintName}»${sprint.create ? " (спринт ще не існує, створю його)" : ""}.`
    : "";

  const resolved = personByQuery(personQuery);
  if ("ambiguous" in resolved) {
    throw new Error(`Ambiguous "${personQuery}": ${resolved.ambiguous.map((p) => p.name).join(", ")}`);
  }
  // An unknown person must not block the ticket: propose it unassigned on the
  // default project, with the requested name kept in the description so a human
  // can assign it later. (Ambiguity above still stops — picking one of several
  // matches silently would misroute.)
  if ("unknown" in resolved) {
    const cfg = routingConfigFromEnv();
    const description = `Виконавець: ${personQuery} (не знайдено в реєстрі)\n\n${desc}`.trim() + sourceLine;
    const params = {
      projectKey: cfg.defaultProject,
      summary,
      description,
      assigneeAccountId: null,
      ...(sprint ? { nextSprint: sprint.params } : {}),
    };
    return {
      kind: "jira_create",
      params,
      echoUk: `📝 Створю задачу в проєкті ${cfg.defaultProject}, виконавець: (не призначено — «${personQuery}» не знайдено в реєстрі)\nЗаголовок: ${summary}\nОпис: ${description}${sprintEcho}\nСтворити? (так/ні)`,
      apply: () => applyProposal("jira_create", params),
    };
  }
  const person = resolved.person;
  const routing = routeIssue(person, routingConfigFromEnv());
  const description =
    (routing.assignInDescription ? `Виконавець: ${person.name}\n\n${desc}`.trim() : desc) + sourceLine;
  const assignee = describeAssignee(person, routing);

  const params = {
    projectKey: routing.projectKey,
    summary,
    description,
    assigneeAccountId: routing.jiraAccountId,
    ...(sprint ? { nextSprint: sprint.params } : {}),
  };
  return {
    kind: "jira_create",
    params,
    echoUk: `📝 Створю задачу в проєкті ${routing.projectKey}, виконавець: ${assignee}\nЗаголовок: ${summary}\nОпис: ${description || "(порожній)"}${sprintEcho}\nСтворити? (так/ні)`,
    apply: () => applyProposal("jira_create", params),
  };
}

async function jiraCommentProposal(args: Record<string, unknown>): Promise<Proposal> {
  const key = str(args, "key");
  const body = str(args, "body");
  const params = { key, body };
  return {
    kind: "jira_comment",
    params,
    echoUk: `📝 Додам коментар до ${key}:\n${body}\nДодати? (так/ні)`,
    apply: () => applyProposal("jira_comment", params),
  };
}

async function jiraTransitionProposal(args: Record<string, unknown>): Promise<Proposal> {
  const key = str(args, "key");
  const transitionId = str(args, "transitionId");
  const params = { key, transitionId };
  return {
    kind: "jira_transition",
    params,
    echoUk: `📝 Переведу ${key} (transition ${transitionId}).\nПродовжити? (так/ні)`,
    apply: () => applyProposal("jira_transition", params),
  };
}

/** Move an existing issue into the next sprint (see resolveNextSprint). The
 *  read happens at propose time so the echo names the real sprint; the executor
 *  re-resolves a planned create at apply time (the sprint may appear between
 *  the two). */
export async function jiraNextSprintProposal(args: Record<string, unknown>): Promise<Proposal> {
  const key = str(args, "key");
  const sprint = await resolveNextSprint();

  const params = { key, ...sprint.params };
  const sprintNote = sprint.create
    ? `«${sprint.params.sprintName}» — спринт ще не існує, створю його`
    : `«${sprint.params.sprintName}»`;
  return {
    kind: "jira_move_to_sprint",
    params,
    echoUk: `📝 Додам ${key} до наступного спринту ${sprintNote} (${sprint.anchorNoteUk}).\nПродовжити? (так/ні)`,
    apply: () => applyProposal("jira_move_to_sprint", params),
  };
}

async function jiraUpdateProposal(args: Record<string, unknown>): Promise<Proposal> {
  const key = str(args, "key");
  const fields = (args.fields ?? {}) as Record<string, unknown>;
  const params = { key, fields };
  return {
    kind: "jira_update",
    params,
    echoUk: `📝 Оновлю ${key}: ${JSON.stringify(fields)}\nПродовжити? (так/ні)`,
    apply: () => applyProposal("jira_update", params),
  };
}

export const jiraTools: Tool[] = [
  {
    name: "jira_search",
    description:
      "Search Jira issues with a JQL query and return matching keys, summaries, and statuses. Use for questions like what was done/resolved, what is open, or to find an issue. JQL examples: 'resolved >= startOfDay()', 'project = ATP AND status = \"In Progress\"'.",
    inputSchema: {
      type: "object",
      properties: {
        jql: { type: "string", description: "A valid Jira JQL query." },
        max: { type: "number", description: "Max rows (default 20)." },
      },
      required: ["jql"],
    },
    kind: "read",
    run: async (args) => {
      const jql = str(args, "jql");
      const max = typeof args.max === "number" ? args.max : 20;
      const rows = await searchIssues(jql, max);
      if (!rows.length) return { ok: true, content: "No issues matched." };
      return { ok: true, content: rows.map((r) => `${r.key} [${r.status}] ${r.summary}`).join("\n") };
    },
  },
  {
    name: "jira_create",
    description:
      "Create a Jira ticket for a named person. Routing is automatic (Mr-Lab people go to the Mr Lab project); a person not in the registry still gets a ticket — unassigned, with their name in the description. Provide the person's name, a summary, and an optional description. If the request ALSO asks to put the ticket into the next sprint («на наступний спринт»), set addToNextSprint: true — one confirmation covers both; do NOT plan a separate follow-up step.",
    inputSchema: {
      type: "object",
      properties: {
        person: { type: "string", description: "Who the ticket is for (name)." },
        summary: { type: "string", description: "Ticket summary." },
        description: { type: "string", description: "Ticket description (optional)." },
        addToNextSprint: {
          type: "boolean",
          description: "true when the ticket should also be placed into the next sprint (resolved automatically).",
        },
      },
      required: ["person", "summary"],
    },
    kind: "write",
    propose: jiraCreateProposal,
  },
  {
    name: "jira_comment",
    description: "Add a comment to a Jira issue.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Issue key, e.g. ATP-42." },
        body: { type: "string", description: "Comment text." },
      },
      required: ["key", "body"],
    },
    kind: "write",
    propose: jiraCommentProposal,
  },
  {
    name: "jira_transition",
    description: "Move a Jira issue to a new status via a transition id.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Issue key." },
        transitionId: { type: "string", description: "Jira transition id." },
      },
      required: ["key", "transitionId"],
    },
    kind: "write",
    propose: jiraTransitionProposal,
  },
  {
    name: "jira_add_to_next_sprint",
    description:
      "Move a Jira issue into the NEXT sprint (the active sprint's number + 1, e.g. ATP 40 → ATP 41). Resolves the sprint on the board automatically and creates it first if it does not exist yet. Use this for requests like 'додай в наступний спринт' — do NOT use jira_update for sprint changes.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Issue key to move, e.g. ATP-1714." },
      },
      required: ["key"],
    },
    kind: "write",
    propose: jiraNextSprintProposal,
  },
  {
    name: "jira_update",
    description:
      "Update fields on a Jira issue. NOT for sprint moves — the Sprint field cannot be set here; use jira_add_to_next_sprint instead.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Issue key." },
        fields: { type: "object", description: "Jira fields object to set." },
      },
      required: ["key", "fields"],
    },
    kind: "write",
    propose: jiraUpdateProposal,
  },
];
