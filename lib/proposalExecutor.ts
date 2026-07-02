/**
 * Deterministic confirm-first executor: given a resolved proposal (kind + params)
 * perform the Jira write and return a Ukrainian result line. This is the ONE apply
 * path — shared by the CLI (`npm run agent --yes`) and the Slack confirm (`так`),
 * so a proposal that survives a DB round-trip (lib/agentProposals) applies exactly
 * like the in-memory CLI path. No LLM here; the model already resolved the params.
 *
 * SERVER-ONLY reachable (lib/jira reads JIRA_* env).
 */
import { createIssue, addComment, transitionIssue, updateIssue } from "@/lib/jira";

export type ProposalKind = "jira_create" | "jira_comment" | "jira_transition" | "jira_update";

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
    default:
      throw new Error(`Unknown proposal kind: ${kind}`);
  }
}
