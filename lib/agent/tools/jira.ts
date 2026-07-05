/**
 * Jira tools for the agent loop. The read tool (jira_search) executes live; the
 * write tools resolve into confirm-first Proposals — the loop never writes. The
 * create proposal applies the Mr-Lab routing rule (lib/jiraRouting.ts), so the
 * echo shows the resolved project and a misroute is caught before creation.
 *
 * Reachable only under server-only conditions (lib/jira.ts). Needs JIRA_* env.
 */
import { searchIssues } from "@/lib/jira";
import { routeIssue, routingConfigFromEnv } from "@/lib/jiraRouting";
import { personByQuery } from "@/lib/people";
import { applyProposal } from "@/lib/proposalExecutor";
import type { Proposal, Tool } from "./types";

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`Missing required "${key}".`);
  return v.trim();
}
function optStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : "";
}

/** Resolve {person, summary, description} → a create Proposal with Mr-Lab routing. */
export async function jiraCreateProposal(args: Record<string, unknown>): Promise<Proposal> {
  const personQuery = str(args, "person");
  const summary = str(args, "summary");
  const desc = optStr(args, "description");

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
    const description = `Виконавець: ${personQuery} (не знайдено в реєстрі)\n\n${desc}`.trim();
    const params = { projectKey: cfg.defaultProject, summary, description, assigneeAccountId: null };
    return {
      kind: "jira_create",
      params,
      echoUk: `📝 Створю задачу в проєкті ${cfg.defaultProject}, виконавець: (не призначено — «${personQuery}» не знайдено в реєстрі)\nЗаголовок: ${summary}\nОпис: ${description}\nСтворити? (так/ні)`,
      apply: () => applyProposal("jira_create", params),
    };
  }
  const person = resolved.person;
  const routing = routeIssue(person, routingConfigFromEnv());
  const description = routing.assignInDescription ? `Виконавець: ${person.name}\n\n${desc}`.trim() : desc;
  const assignee = routing.jiraAccountId ?? `(в описі) ${person.name}`;

  const params = { projectKey: routing.projectKey, summary, description, assigneeAccountId: routing.jiraAccountId };
  return {
    kind: "jira_create",
    params,
    echoUk: `📝 Створю задачу в проєкті ${routing.projectKey}, виконавець: ${assignee}\nЗаголовок: ${summary}\nОпис: ${description || "(порожній)"}\nСтворити? (так/ні)`,
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
      "Create a Jira ticket for a named person. Routing is automatic (Mr-Lab people go to the Mr Lab project); a person not in the registry still gets a ticket — unassigned, with their name in the description. Provide the person's name, a summary, and an optional description.",
    inputSchema: {
      type: "object",
      properties: {
        person: { type: "string", description: "Who the ticket is for (name)." },
        summary: { type: "string", description: "Ticket summary." },
        description: { type: "string", description: "Ticket description (optional)." },
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
    name: "jira_update",
    description: "Update fields on a Jira issue.",
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
