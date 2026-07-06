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
import type { Tool } from "./types";

function kyivMonth(): { start: string; end: string } {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: FIELD_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const [y, m] = today.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(last).padStart(2, "0")}` };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
];
