/**
 * Who may talk to the Slack agent. Pure — reuses the hardcoded people registry
 * (lib/people.ts): anyone with a Slack id in the roster is allowed (broader than
 * the 2 verdict approvers). An unknown user gets a fixed Ukrainian refusal.
 */
import { personForSlackId } from "../people";

export function isAllowedSlackUser(userId: string): boolean {
  if (!userId) return false;
  return personForSlackId(userId) !== undefined;
}

export const AGENT_REFUSAL_UK =
  "Вибач, я тебе не впізнаю — не можу виконати запит. Звернись до адміністратора, щоб тебе додали.";
