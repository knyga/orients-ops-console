/**
 * Field drone-loss read tool for the agent loop: the loss ledger, the
 * unrecovered counter, and the distance to the >3-loss month wipe. Read-only —
 * executes live inside the loop (like jira_search). Loss corrections go through
 * the approver instruction axis, not the agent.
 */
import { readLossRecords } from "@/lib/lossStore";
import { effectiveLosses } from "@/lib/lossLedger";
import { TEAM_LOSS_CUTOFF } from "@/lib/fieldBonus";
import { FIELD_TIMEZONE } from "@/lib/reconcile";
import { applyProposal } from "@/lib/proposalExecutor";
import type { Tool, Proposal } from "./types";

function kyivMonth(): { start: string; end: string } {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: FIELD_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const [y, m] = today.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(last).padStart(2, "0")}` };
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Resolve {date, state, note?} into a confirm-first day-wide loss correction. */
export async function fieldLossSetProposal(args: Record<string, unknown>): Promise<Proposal> {
  const date = typeof args.date === "string" ? args.date.trim() : "";
  if (!DATE_RE.test(date)) throw new Error(`Invalid date "${args.date}" — use YYYY-MM-DD.`);
  const state = args.state === "found" || args.state === "lost" ? args.state : null;
  if (!state) throw new Error(`Invalid state "${args.state}" — use "found" or "lost".`);
  const note = typeof args.note === "string" && args.note.trim() ? args.note.trim() : undefined;
  const params: Record<string, unknown> = { date, state, ...(note ? { note } : {}) };
  const echoUk =
    state === "found"
      ? `🛸 Борт ${date}: знайдено — втрату знято${note ? ` (${note})` : ""}. Застосувати? (так/ні)`
      : `🛸 Борт ${date}: втрачено (не знайдено)${note ? ` (${note})` : ""}. Застосувати? (так/ні)`;
  return { kind: "field_loss_set", params, echoUk, apply: () => applyProposal("field_loss_set", params) };
}

export const fieldLossTools: Tool[] = [
  {
    name: "field_loss_status",
    description:
      "Drone-loss ledger for a period: which flight days lost a drone (втрата борта), which were recovered (знайшли), " +
      "the unrecovered count, and how close the team is to the >3-loss month wipe. " +
      "Use for questions about втрати бортів / lost drones / drone-loss penalties. Dates are YYYY-MM-DD; defaults to the current Kyiv month.",
    inputSchema: {
      type: "object",
      properties: {
        start: { type: "string", description: "Period start (YYYY-MM-DD). Default: current Kyiv month." },
        end: { type: "string", description: "Period end (YYYY-MM-DD). Default: current Kyiv month." },
      },
      required: [],
    },
    kind: "read",
    run: async (args) => {
      const fallback = kyivMonth();
      const start = typeof args.start === "string" && DATE_RE.test(args.start) ? args.start : fallback.start;
      const end = typeof args.end === "string" && DATE_RE.test(args.end) ? args.end : fallback.end;
      const losses = effectiveLosses(await readLossRecords(), { start, end });
      const unrecovered = losses.filter((l) => !l.found).length;
      const lines = losses.map((l) => `${l.date}: ${l.found ? "знайдено ✅" : "втрачено ⚠️"} — ${l.note}`);
      return {
        ok: true,
        content: [
          `Втрати бортів ${start}..${end}:`,
          ...(lines.length ? lines : ["Втрат немає."]),
          `Невідновлених втрат: ${unrecovered} (ліміт ${TEAM_LOSS_CUTOFF} на місяць; ${TEAM_LOSS_CUTOFF + 1}-та обнуляє місячний бонус усієї команди).`,
        ].join("\n"),
      };
    },
  },
  {
    name: "field_loss_set",
    description:
      "Record a drone-loss correction for a flight day: state=found marks a lost drone as recovered (the loss no longer counts — «борт знайшли»); " +
      "state=lost confirms it is permanently lost. Confirm-first: the user must approve the proposal; only approvers can apply it. " +
      "Use when the user reports a drone was found or definitively lost. Date is the FLIGHT day (YYYY-MM-DD) — check field_loss_status first if unsure which date carries the loss.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Flight date YYYY-MM-DD the loss belongs to." },
        state: { type: "string", enum: ["found", "lost"], description: "found = recovered (clears the loss); lost = permanently lost." },
        note: { type: "string", description: "Short reason/context (optional)." },
      },
      required: ["date", "state"],
    },
    kind: "write",
    propose: fieldLossSetProposal,
  },
];
