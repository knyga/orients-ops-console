/**
 * Read tool: the verdict of a flight day (every Звіт of the date) — status,
 * Ukrainian gaps, numbers, crew, links. Backs the verdict-thread chat and the
 * agent CLI («що бракує за 04.09?»). Read-only; never writes.
 */
import { readReportJson } from "@/lib/reports";
import { ukrainianGaps } from "@/lib/verdictPublish";
import { TRACKED_CHANNELS } from "@/lib/slackChannels";
import type { DayVerdict } from "@/lib/fieldDayVerdict";
import type { Tool } from "./types";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FIELD_QA_ID = TRACKED_CHANNELS.find((c) => c.name === "field-qa")?.id ?? "";

function permalink(channelId: string, ts: string): string {
  return `https://slack.com/archives/${channelId}/p${ts.replace(".", "")}`;
}

export function renderVerdictStatus(days: DayVerdict[], date: string, fieldQaChannelId: string): string {
  const rows = days.filter((d) => d.date === date);
  if (rows.length === 0) return `За ${date} немає вердикту (день не літали або звіт ще не оброблено).`;
  return rows
    .map((d) => {
      const head = rows.length > 1 ? `Виїзд ${d.reportSeq}/${d.reportCount}${d.deployWindow ? ` (${d.deployWindow.start}–${d.deployWindow.end})` : ""}` : `День ${date}`;
      const pct = d.ratio === null ? "—" : `${Math.round(d.ratio * 100)}%`;
      const gaps = ukrainianGaps(d);
      return [
        `${head}: статус ${d.status}.`,
        `Цифри: відео ${d.videoMinutes.toFixed(0)} хв = ${pct} від ${d.airborneMinutes.toFixed(0)} хв у повітрі; датасет: ${d.datasetStatus}; виїзд: ${d.deployMin ?? "невідомо"} хв.`,
        gaps.length ? `Бракує: ${gaps.join("; ")}.` : `Прогалин немає.`,
        `Екіпаж: ${d.roster.join(", ") || "невідомий"}.`,
        d.reportTs ? `Звіт: ${permalink(fieldQaChannelId, d.reportTs)}` : "",
      ].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

export const fieldVerdictTools: Tool[] = [
  {
    name: "field_verdict_status",
    description:
      "The field-day verdict for one date: status (ACCEPTED/PENDING/NEEDS_REVIEW/ACCEPTED_EXCEPTION/REJECTED), what is missing (video %, dataset, deploy window), " +
      "the numbers, the crew and a link to the Звіт. Use for «що бракує за DD.MM», «чому день не прийнято», «який статус». Date is YYYY-MM-DD.",
    inputSchema: { type: "object", properties: { date: { type: "string", description: "Flight day YYYY-MM-DD" } }, required: ["date"] },
    kind: "read",
    run: async (args) => {
      const date = typeof args.date === "string" ? args.date.trim() : "";
      if (!DATE_RE.test(date)) return { ok: false, content: `Некоректна дата «${args.date}» — потрібно YYYY-MM-DD.` };
      const report = await readReportJson<{ days: DayVerdict[] }>("field-verdict", date.slice(0, 7));
      return { ok: true, content: renderVerdictStatus(report?.days ?? [], date, FIELD_QA_ID) };
    },
  },
];
