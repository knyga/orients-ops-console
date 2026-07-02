/** Deterministic reply classification for a linear DM with a PENDING proposal
 *  (Phase C.2). No LLM. "other" supersedes the pending proposal and starts a new turn. */
export type DmReply = "confirm" | "cancel" | "other";

const CONFIRM = new Set(["так", "ок", "ok", "+", "👍", "да", "yes", "y"]);
const CANCEL = new Set(["ні", "ni", "no", "n", "скасуй", "скасувати", "👎"]);

export function classifyDmReply(text: string): DmReply {
  const t = text.trim().toLowerCase();
  if (CONFIRM.has(t)) return "confirm";
  if (CANCEL.has(t)) return "cancel";
  if (/^ні[,\s]/.test(t)) return "cancel"; // "ні, скасуй"
  return "other";
}
