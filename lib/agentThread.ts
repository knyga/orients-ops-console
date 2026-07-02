/**
 * Per-DM agent conversation memory (Phase C.2). Stores lightweight text turns only
 * (no raw tool_use/tool_result/thinking blocks — those go stale and drag in
 * same-model replay rules; tools re-run fresh each turn). Applies the pure
 * capTranscript window on both read and write. NOT server-only.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "./db";
import { capTranscript, type Turn } from "./agentThreadCap";

export type { Turn } from "./agentThreadCap";

export async function loadTranscript(channelId: string): Promise<Turn[]> {
  const rows = await db.select().from(schema.agentThreads).where(eq(schema.agentThreads.channelId, channelId));
  if (rows.length === 0) return [];
  const r = rows[0];
  const prior = Array.isArray(r.transcript) ? (r.transcript as Turn[]) : [];
  return capTranscript(prior, Date.now(), Date.parse(r.updatedAt));
}

export async function appendTurn(channelId: string, userText: string, assistantText: string): Promise<void> {
  const prior = await loadTranscript(channelId);
  const next = capTranscript(
    [...prior, { role: "user", text: userText }, { role: "assistant", text: assistantText }],
    Date.now(),
    Date.now(),
  );
  const nowIso = new Date().toISOString();
  await db
    .insert(schema.agentThreads)
    .values({ channelId, updatedAt: nowIso, transcript: next })
    .onConflictDoUpdate({ target: schema.agentThreads.channelId, set: { updatedAt: nowIso, transcript: next } });
}

/** True iff an agent conversation row exists for this key (ignores the 24h cap —
 *  used only for ingress routing, not for seeding history). */
export async function agentThreadExists(conversationKey: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(schema.agentThreads)
    .where(eq(schema.agentThreads.channelId, conversationKey));
  return rows.length > 0;
}
