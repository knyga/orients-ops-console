/**
 * Sprint-plan fill-in write tool for the agent loop (see
 * docs/superpowers/specs/2026-08-26-sprint-plan-fallback-design.md). When the
 * Tuesday commit cron finds no active sprint it posts a fallback anchor to
 * #general; once the sprint exists, an approver @mentions the bot in that
 * anchor's thread and this tool proposes the fill-in: freeze the baseline,
 * rewrite the anchor in place into the real Committed post, and thread the
 * per-assignee details under it. Confirm-first like every write — the loop
 * never executes it; `apply()` goes through the deterministic executor, which
 * also guards that the target really is a pending-plan anchor.
 */
import { boardIdFromEnv, fetchSprintIssues, listSprints, type Sprint } from "@/lib/jira";
import { applyProposal } from "@/lib/proposalExecutor";
import type { Proposal, ProposeContext, Tool } from "./types";

/** Resolve the target sprint live: an explicit name/id among active+future,
 *  else the board's single active sprint. Throws (Ukrainian — the loop feeds
 *  tool errors back for the model to relay) when nothing matches. */
async function resolveTargetSprint(boardId: number, query?: string): Promise<Sprint> {
  if (query) {
    const [active, future] = await Promise.all([
      listSprints(boardId, "active"),
      listSprints(boardId, "future"),
    ]);
    const q = query.trim().toLowerCase();
    const found = [...active, ...future].find(
      (s) => s.name.trim().toLowerCase() === q || String(s.id) === q,
    );
    if (!found) {
      throw new Error(`спринт «${query}» не знайдено серед активних чи майбутніх — перевірте назву в Jira.`);
    }
    return found;
  }
  const active = await listSprints(boardId, "active");
  if (!active[0]) {
    throw new Error("на дошці ще немає активного спринту — створіть його в Jira і спробуйте знову.");
  }
  return active[0];
}

/** Resolve {sprint?} + the conversation context into a confirm-first fill-in. */
export async function sprintPlanBuildProposal(
  args: Record<string, unknown>,
  ctx?: ProposeContext,
): Promise<Proposal> {
  // A DM has no anchor to rewrite — the tool is only usable from a thread.
  if (!ctx?.channelId || !ctx.threadTs) {
    throw new Error("цей інструмент працює лише у треді повідомлення-заглушки плану спринту.");
  }
  const query = typeof args.sprint === "string" && args.sprint.trim() ? args.sprint.trim() : undefined;
  const sprint = await resolveTargetSprint(boardIdFromEnv(), query);
  // A live count at PROPOSE time, so the approver confirms against a real
  // number. The apply re-fetches; a scope change between propose and confirm
  // lands in the baseline, not the echo.
  const issues = await fetchSprintIssues(sprint.id);
  // Serializable — the proposal survives the Slack confirm round-trip in agent_proposals.
  const params: Record<string, unknown> = {
    channelId: ctx.channelId,
    anchorTs: ctx.threadTs,
    sprintId: sprint.id,
    sprintName: sprint.name,
  };
  return {
    kind: "sprint_plan_build",
    params,
    echoUk: `📋 Складу план спринту ${sprint.name} (${issues.length} задач) і оновлю повідомлення вище. Застосувати? (так/ні)`,
    apply: () => applyProposal("sprint_plan_build", params),
  };
}

export const sprintTools: Tool[] = [
  {
    name: "sprint_plan_build",
    description:
      "Build the weekly sprint plan (the Committed baseline) for the fallback anchor this thread hangs under: " +
      "freezes the sprint's issue set, rewrites the «План спринту не складено» message above into the real Committed post, " +
      "and threads the per-assignee details under it. Use when asked «склади план спринту» in such a thread. " +
      "Confirm-first and approver-only; only works in a thread whose anchor is the bot's pending-plan post. " +
      "Optional `sprint` names a specific sprint (\"ATP 49\" or an id); omitted means the board's active sprint.",
    inputSchema: {
      type: "object",
      properties: {
        sprint: {
          type: "string",
          description: 'Sprint name or id (e.g. "ATP 49", "1487"). Omit for the board\'s active sprint.',
        },
      },
      required: [],
    },
    kind: "write",
    propose: sprintPlanBuildProposal,
  },
];
