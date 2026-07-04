/** Extract a day's #field-qa drone-count report into per-person / per-category
 *  entries via Claude. SERVER-ONLY. `present` is derived (some report has
 *  entries), so the field-bonus gate (which reads .present) is unchanged. */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  DRONE_COUNT_TOOL,
  buildDroneCountPrompt,
  type DroneCountResult,
  type DroneDayReport,
} from "./droneCountReportPrompt";
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

/** Coerce raw tool input into clean reports: drop reports left with no entries. */
function sanitizeReports(raw: unknown): DroneDayReport[] {
  if (!Array.isArray(raw)) return [];
  const out: DroneDayReport[] = [];
  for (const r of raw) {
    const rec = (r ?? {}) as Record<string, unknown>;
    const entries = sanitizeEntries(rec.entries);
    if (entries.length === 0) continue;
    const forDateRaw = typeof rec.forDate === "string" ? rec.forDate : "";
    out.push({ entries, forDate: DATE_RE.test(forDateRaw) ? forDateRaw : null });
  }
  return out;
}

export async function classifyDroneCount(dayText: string, postedOn?: string): Promise<DroneCountResult> {
  if (!dayText.trim()) return { present: false, reports: [], note: "" };
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
  const reports = sanitizeReports(input.reports);
  return { present: reports.length > 0, reports, note: String(input.note ?? "") };
}
