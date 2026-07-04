/** Extract a day's #field-qa drone-count report into per-person / per-category
 *  entries via Claude. SERVER-ONLY. `present` is derived (entries.length > 0),
 *  so the field-bonus gate (which reads .present) is unchanged. */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { DRONE_COUNT_TOOL, buildDroneCountPrompt, type DroneCountResult } from "./droneCountReportPrompt";
import type { DroneEntry } from "./droneReport";

const MODEL = "claude-sonnet-4-6";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Coerce raw tool input into clean DroneEntry[]: drop blank names / bad counts. */
function sanitizeEntries(raw: unknown): DroneEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: DroneEntry[] = [];
  for (const e of raw) {
    const rec = (e ?? {}) as Record<string, unknown>;
    const name = String(rec.name ?? "").trim();
    const count = Math.round(Number(rec.count));
    if (!name || !Number.isFinite(count) || count <= 0) continue;
    out.push({ name, isPerson: Boolean(rec.isPerson), count });
  }
  return out;
}

export async function classifyDroneCount(dayText: string, postedOn?: string): Promise<DroneCountResult> {
  if (!dayText.trim()) return { present: false, entries: [], forDate: null, note: "" };
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set (needed for field-bonus drone-count gate).");
  const client = new Anthropic();
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    tools: [DRONE_COUNT_TOOL],
    tool_choice: { type: "tool", name: DRONE_COUNT_TOOL.name },
    messages: [{ role: "user", content: [{ type: "text", text: buildDroneCountPrompt(dayText, postedOn) }] }],
  });
  const block = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  const input = (block?.input ?? {}) as Record<string, unknown>;
  const entries = sanitizeEntries(input.entries);
  const forDateRaw = typeof input.forDate === "string" ? input.forDate : "";
  const forDate = DATE_RE.test(forDateRaw) ? forDateRaw : null;
  return { present: entries.length > 0, entries, forDate, note: String(input.note ?? "") };
}
