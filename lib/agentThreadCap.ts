/** Pure transcript window policy for DM agent memory (Phase C.2). */
export type Turn = { role: "user" | "assistant"; text: string };

const MAX_TURNS = 10;
const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Keep the last MAX_TURNS turns, unless the thread's last activity is older than
 *  WINDOW_MS — then treat it as a fresh conversation (drop all prior turns). */
export function capTranscript(turns: Turn[], nowMs: number, updatedAtMs: number): Turn[] {
  if (nowMs - updatedAtMs > WINDOW_MS) return [];
  return turns.slice(-MAX_TURNS);
}

/** Should a bot-sent Slack message be recorded into the DM agent memory?
 *  Only genuinely top-level DM sends, and never the agent's own sends —
 *  the run route records those as full user/assistant turns already. */
export function shouldRecordDmBotTurn(channelId: string, threadTs: string | null, feature: string): boolean {
  return channelId.startsWith("D") && threadTs === null && feature !== "agent";
}
