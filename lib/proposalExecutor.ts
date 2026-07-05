/**
 * Deterministic confirm-first executor: given a resolved proposal (kind + params)
 * perform the Jira write and return a Ukrainian result line. This is the ONE apply
 * path — shared by the CLI (`npm run agent --yes`) and the Slack confirm (`так`),
 * so a proposal that survives a DB round-trip (lib/agentProposals) applies exactly
 * like the in-memory CLI path. No LLM here; the model already resolved the params.
 *
 * SERVER-ONLY reachable (lib/jira reads JIRA_* env).
 */
import {
  createIssue,
  addComment,
  transitionIssue,
  updateIssue,
  listSprints,
  createSprint,
  moveIssueToSprint,
} from "@/lib/jira";

export type ProposalKind =
  | "jira_create"
  | "jira_comment"
  | "jira_transition"
  | "jira_update"
  | "jira_move_to_sprint";

function str(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`Missing required "${key}".`);
  return v;
}

export async function applyProposal(kind: ProposalKind, params: Record<string, unknown>): Promise<string> {
  switch (kind) {
    case "jira_create": {
      const accountId = params.assigneeAccountId;
      const created = await createIssue({
        projectKey: str(params, "projectKey"),
        summary: str(params, "summary"),
        description: typeof params.description === "string" ? params.description : "",
        assigneeAccountId: typeof accountId === "string" ? accountId : null,
      });
      return `✅ Створено ${created.key}: ${created.url}`;
    }
    case "jira_comment":
      await addComment(str(params, "key"), str(params, "body"));
      return `✅ Коментар додано до ${str(params, "key")}`;
    case "jira_transition":
      await transitionIssue(str(params, "key"), str(params, "transitionId"));
      return `✅ ${str(params, "key")} переведено`;
    case "jira_update": {
      const fields = (params.fields ?? {}) as Record<string, unknown>;
      await updateIssue(str(params, "key"), fields);
      return `✅ ${str(params, "key")} оновлено`;
    }
    case "jira_move_to_sprint": {
      const key = str(params, "key");
      const sprintName = str(params, "sprintName");
      const boardId = typeof params.boardId === "number" ? params.boardId : Number(params.boardId);
      let sprintId = typeof params.sprintId === "number" ? params.sprintId : null;
      let created = false;
      // A propose-time "create it" plan re-checks at apply time: the sprint may
      // have appeared between the proposal and the confirmation.
      if (sprintId === null) {
        const future = await listSprints(boardId, "future");
        const existing = future.find((s) => s.name.trim().toLowerCase() === sprintName.trim().toLowerCase());
        if (existing) {
          sprintId = existing.id;
        } else {
          sprintId = (await createSprint(boardId, sprintName)).id;
          created = true;
        }
      }
      await moveIssueToSprint(sprintId, key);
      return created
        ? `✅ ${key} додано до спринту «${sprintName}» (спринт створено)`
        : `✅ ${key} додано до спринту «${sprintName}»`;
    }
    default:
      throw new Error(`Unknown proposal kind: ${kind}`);
  }
}
