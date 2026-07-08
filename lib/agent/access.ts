/**
 * Who may talk to the Slack agent. Pure — restricted to the hardcoded verdict
 * approvers (lib/approvers.ts) for now, to prevent misuse while the agent's
 * write surface matures; the wider lib/people.ts roster is deliberately NOT
 * enough. An unknown user gets a fixed Ukrainian refusal.
 */
import { isApprover } from "../approvers";

export function isAllowedSlackUser(userId: string): boolean {
  if (!userId) return false;
  return isApprover(userId);
}

export const AGENT_REFUSAL_UK =
  "Вибач, я тебе не впізнаю — не можу виконати запит. Звернись до адміністратора, щоб тебе додали.";
