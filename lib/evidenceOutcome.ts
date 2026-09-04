/**
 * Pure outcome of an evidence re-check (pilot evidence autonomy, spec §4): the
 * fresh verdict → closed / still_open / hard_fail + the Ukrainian text the bot
 * posts, with DETERMINISTIC cause hints (a Vimeo video named without the date,
 * a #datasets message dated another day). Never model text.
 */
import { MIN_RATIO, videoNameDate, videoUploadDate } from "./reconcile";
import { ukrainianGaps } from "./verdictPublish";
import { MIN_VIDEO_MIN } from "./fieldDayVerdict";
import type { DayVerdict } from "./fieldDayVerdict";
import type { ReplyHints } from "./threadReplyHints";

export type EvidenceOutcomeKind = "closed" | "still_open" | "hard_fail";
export interface LinkedVideo { id: string; name: string; created_time: string; link: string }
export interface OutcomeArgs {
  day: DayVerdict | null;
  byName: string;
  hints: ReplyHints;
  linkedVideos: LinkedVideo[];
  datasetLinkDates: Map<string, string>;
}

const ddmm = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

function numbersLine(d: DayVerdict): string {
  const pct = d.ratio === null ? "—" : `${Math.round(d.ratio * 100)}%`;
  const ds = d.datasetStatus === "POSTED" || d.datasetStatus === "WAIVED" ? "датасет є" : "датасету немає";
  return `відео ${d.videoMinutes.toFixed(0)} хв = ${pct} від ${d.airborneMinutes.toFixed(0)} хв у повітрі, ${ds}`;
}

function causeHints(a: OutcomeArgs, date: string): string[] {
  const out: string[] = [];
  for (const l of a.hints.vimeoLinks) {
    const v = a.linkedVideos.find((x) => x.id === l.id);
    if (!v) { out.push(`відео ${l.url} не знайдено в акаунті Vimeo`); continue; }
    const named = videoNameDate(v.name, v.created_time);
    if (named === null) {
      const uploadDate = videoUploadDate(v.created_time);
      out.push(
        `відео «${v.name}» без дати в назві — зараховано на ${ddmm(uploadDate)} (дата завантаження); перейменуйте, додавши дату у форматі YYYY-MM-DD — ${date} (${ddmm(date)})`,
      );
      continue;
    }
    if (named !== date) {
      out.push(`відео «${v.name}» датоване ${ddmm(named)}, не цим днем`);
    }
  }
  for (const p of a.hints.datasetPermalinks) {
    const d = a.datasetLinkDates.get(p.ts);
    if (d && d !== date) out.push(`повідомлення в #datasets датоване іншим днем (${ddmm(d)})`);
  }
  return out;
}

export function evidenceOutcome(a: OutcomeArgs): { outcome: EvidenceOutcomeKind; text: string; verifyLine: string } {
  if (!a.day) {
    return { outcome: "still_open", text: `🔎 Перевірив, але не знайшов цей звіт у свіжому розрахунку — спробуйте пізніше або напишіть затверджувачам.`, verifyLine: "звіт не знайдено" };
  }
  const d = a.day;
  const line = numbersLine(d);
  if (d.status === "ACCEPTED" || d.status === "ACCEPTED_EXCEPTION") {
    return { outcome: "closed", text: `✅ Перевірив: ${line} — день прийнято. Дякую, ${a.byName}.`, verifyLine: line };
  }
  if (d.status === "REJECTED") {
    const gaps = ukrainianGaps(d).join("; ");
    return {
      outcome: "hard_fail",
      text: `⛔ День відхилено (${gaps}) — відео чи датасет тут не допоможуть. Якщо є пояснення, напишіть його — передам затверджувачам.`,
      verifyLine: line,
    };
  }
  const parts: string[] = [`🔎 Перевірив: ${line}.`];
  const videoOk = d.ratio !== null && d.ratio >= MIN_RATIO && d.videoMinutes >= MIN_VIDEO_MIN;
  if (!videoOk && d.airborneMinutes > 0) {
    const need = Math.max(0, Math.ceil(Math.max(d.airborneMinutes * MIN_RATIO, MIN_VIDEO_MIN) - d.videoMinutes));
    parts.push(`бракує ${need} хв відео.`);
  }
  const otherGaps = ukrainianGaps(d).filter((g) => !g.startsWith("відео"));
  if (otherGaps.length) parts.push(`Також: ${otherGaps.join("; ")}.`);
  const causes = causeHints(a, d.date);
  if (causes.length) parts.push(`Можлива причина: ${causes.join("; ")}.`);
  return { outcome: "still_open", text: parts.join(" "), verifyLine: line };
}
