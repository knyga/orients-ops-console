/**
 * Pure logic for the weekly investor report: previous-Mon–Sun window math,
 * slicing the monthly field-qa/field-verdict day rows to the week, Ukrainian
 * rendering (summary first, then bullet blocks), the Claude prompt and its
 * deterministic fallback. No I/O, no React/Next imports — unit-tested, same
 * discipline as lib/reconcile.ts.
 *
 * NOTE: the store/period key is ALWAYS `${start}_${end}`. `periodKey()` would
 * collapse a same-month week to `YYYY-MM`, colliding with monthly reports.
 */

export interface WeekWindow {
  start: string; // Monday, YYYY-MM-DD
  end: string;   // Sunday, YYYY-MM-DD
  key: string;   // `${start}_${end}` — never the collapsed monthly key
}

/** Shift a YYYY-MM-DD by `days` (UTC math — date-only strings, no DST drift). */
function shiftDay(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The previous COMPLETED Mon–Sun week strictly before `today` (a Kyiv date). */
export function computeWeekWindow(today: string): WeekWindow {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const sinceMonday = (dow + 6) % 7; // days back to this week's Monday
  const thisMonday = shiftDay(today, -sinceMonday);
  const start = shiftDay(thisMonday, -7);
  const end = shiftDay(thisMonday, -1);
  return { start, end, key: `${start}_${end}` };
}

/** The 1–2 monthly report keys (`YYYY-MM`) the window's days live in. */
export function monthKeysCovering(window: WeekWindow): string[] {
  const startMonth = window.start.slice(0, 7);
  const endMonth = window.end.slice(0, 7);
  return startMonth === endMonth ? [startMonth] : [startMonth, endMonth];
}

// -- gathered data ------------------------------------------------------------

export interface InvestorWeekData {
  window: WeekWindow;
  jira: {
    resolved: number;
    storyPoints: number;
    /** Up to 5 issue titles fed to the summary prompt (never printed as bullets). */
    noteworthy: { key: string; summary: string }[];
  };
  /** Null when no completed sprint report matched the window (line omitted). */
  sprint: { name: string; rate: number; completed: number; committed: number } | null;
  field: {
    /** Звіт count (real reports; synthetic no-Звіт rows excluded). */
    reports: number;
    accepted: number; // ACCEPTED + ACCEPTED_EXCEPTION
    flagged: number;  // NEEDS_REVIEW + PENDING
    fieldHours: number;
    airHours: number;
    flightDays: number;
  };
  video: { count: number; minutes: number };
  datasets: { noticeDays: number };
}

/** The stored record (feature `investor` in the reports table) = the web's render source. */
export interface InvestorRecord {
  data: InvestorWeekData;
  summary: string;
  summarySource: "claude" | "fallback";
  message: string;
  generatedAt: string; // ISO
}

// Narrow structural inputs — keeps this module free of server-adjacent imports.
interface FieldQaDayIn { date: string; airborneMinutes: number; flew: boolean }
interface VerdictDayIn {
  date: string;
  reportTs: string | null;
  status: string;
  datasetStatus: string;
  deployMin?: number | null;
  hasZvit?: boolean;
}
interface VideoIn { duration: number } // seconds

export interface BuildInput {
  window: WeekWindow;
  jiraTotals: { totalResolved: number; totalStoryPoints: number };
  noteworthy: { key: string; summary: string }[];
  sprint: InvestorWeekData["sprint"];
  fieldQaDays: FieldQaDayIn[];
  verdictDays: VerdictDayIn[];
  videos: VideoIn[];
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const inWindow = (date: string, w: WeekWindow): boolean => date >= w.start && date <= w.end;

/** Slice the raw rows to the window and aggregate into the report data. */
export function buildWeekData(input: BuildInput): InvestorWeekData {
  const { window } = input;

  const qaDays = input.fieldQaDays.filter((d) => inWindow(d.date, window));
  const airHours = round1(qaDays.reduce((s, d) => s + d.airborneMinutes, 0) / 60);
  const flightDays = qaDays.filter((d) => d.flew).length;

  // Real Звіт rows only; a synthetic no-Звіт row (hasZvit === false) is a day
  // marker, not a field trip.
  const reports = input.verdictDays.filter((d) => inWindow(d.date, window) && d.hasZvit !== false);
  const accepted = reports.filter((d) => d.status === "ACCEPTED" || d.status === "ACCEPTED_EXCEPTION").length;
  const flagged = reports.filter((d) => d.status === "NEEDS_REVIEW" || d.status === "PENDING").length;
  const fieldHours = round1(
    reports.reduce((s, d) => s + (typeof d.deployMin === "number" ? d.deployMin : 0), 0) / 60,
  );

  // Dataset axis is day-shared — dedupe per date across a day's reports.
  const noticeDates = new Set(
    input.verdictDays
      .filter((d) => inWindow(d.date, window) && d.datasetStatus === "POSTED")
      .map((d) => d.date),
  );

  const videoMinutes = Math.round(input.videos.reduce((s, v) => s + v.duration, 0) / 60);

  return {
    window,
    jira: {
      resolved: input.jiraTotals.totalResolved,
      storyPoints: input.jiraTotals.totalStoryPoints,
      noteworthy: input.noteworthy.slice(0, 15),
    },
    sprint: input.sprint,
    field: { reports: reports.length, accepted, flagged, fieldHours, airHours, flightDays },
    video: { count: input.videos.length, minutes: videoMinutes },
    datasets: { noticeDays: noticeDates.size },
  };
}

// -- sprint pick ----------------------------------------------------------------

export interface SprintPick {
  name: string;
  computedAt: string; // ISO
  rate: number;
  completed: number;
  committed: number;
}

/**
 * The completed sprint report belonging to this week: computedAt (the Sunday
 * cron) falls inside the window, with +2 days of tolerance for late/manual
 * re-runs. Candidates arrive newest-first; the first match wins.
 */
export function pickSprintCompletion(
  records: SprintPick[],
  window: WeekWindow,
): InvestorWeekData["sprint"] {
  const latestOk = shiftDay(window.end, 2);
  for (const r of records) {
    const day = r.computedAt.slice(0, 10);
    if (day >= window.start && day <= latestOk) {
      return { name: r.name, rate: r.rate, completed: r.completed, committed: r.committed };
    }
  }
  return null;
}

// -- rendering ---------------------------------------------------------------

const MONTHS_GEN = [
  "січня", "лютого", "березня", "квітня", "травня", "червня",
  "липня", "серпня", "вересня", "жовтня", "листопада", "грудня",
];

function dayLabel(date: string, withYear: boolean): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${d} ${MONTHS_GEN[m - 1]}${withYear ? ` ${y}` : ""}`;
}

/** "20–26 липня 2026" / "27 липня – 2 серпня 2026" / "28 грудня 2026 – 3 січня 2027". */
export function formatWeekLabel(start: string, end: string): string {
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  if (sameMonth) {
    return `${Number(start.slice(8, 10))}–${dayLabel(end, true)}`;
  }
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  return `${dayLabel(start, !sameYear)} – ${dayLabel(end, true)}`;
}

/**
 * The exact #general post: title, then the 3–5 «•» key-result bullets (Claude
 * or fallback), then one compact «Цифри тижня» list. House report style: round
 * bullets, 3–5 items per list, each point ≤ ~10 words — scannable, never a
 * narrative paragraph. Investor-facing scope: concrete results, no task/sprint
 * counts, no internal acceptance statuses, no dataset-day counts (those all
 * stay in the stored record for the internal web tab).
 */
export function formatInvestorMessage(summary: string, data: InvestorWeekData): string {
  return [
    `📊 Тижневий звіт — ${formatWeekLabel(data.window.start, data.window.end)}`,
    "",
    summary.trim(),
    "",
    "Цифри тижня:",
    // Deliberately just the trip count — flight-day and dataset-day counts can
    // legitimately diverge from it (flights without a formal Звіт, dataset
    // posts on non-flight days) and read as contradictions to investors.
    `• Виїзди: ${data.field.reports}`,
    `• У повітрі ${data.field.airHours} год, у полі ${data.field.fieldHours} год`,
    `• Відео: ${data.video.count} роликів, ${data.video.minutes} хв`,
  ].join("\n");
}

/** Deterministic «•» key-result bullets used when the Claude summary call fails. */
export function fallbackSummary(data: InvestorWeekData): string {
  return [
    `• ${data.field.reports} польових виїздів, ${data.field.airHours} год у повітрі`,
    `• ${data.field.fieldHours} год роботи у полі`,
    `• Записано ${data.video.minutes} хв відео для навчання моделей`,
  ].join("\n");
}

/**
 * Normalize the model's summary into 3–5 «• » bullet lines: accepts •/-/* line
 * markers, drops everything else, caps at 5. Returns null when no bullet lines
 * survive (caller falls back to the deterministic bullets).
 */
export function normalizeSummaryBullets(text: string): string | null {
  const bullets = text
    .split("\n")
    .map((l) => l.trim())
    .map((l) => l.replace(/^[-*•]\s+/, "• ").replace(/^•\s*/, "• "))
    .filter((l) => l.startsWith("• ") && l.length > 2)
    .slice(0, 5);
  return bullets.length ? bullets.join("\n") : null;
}

/**
 * The one Claude call's prompt: KEY RESULTS only — what capability was
 * delivered/improved and why it matters, drawn from the resolved-issue titles
 * and field outcomes. Task/sprint counts and internal statuses are deliberately
 * NOT in the prompt (investors don't care, and their absence makes «13 із 54
 * задач» bullets impossible). Numbers that ARE passed (hours, videos, flights)
 * may be used but never invented. Output contract: 3–5 «• » bullets, ≤10 words.
 */
export function buildInvestorPrompt(data: InvestorWeekData): string {
  return [
    "Ти пишеш короткий тижневий звіт для ангел-інвесторів української оборонної компанії, що розробляє автопілот для FPV-дронів.",
    "Інвестори добре розуміють бойове застосування, але не технічні нюанси — без жаргону.",
    "Поверни РІВНО 3–5 рядків-пунктів українською. Кожен рядок починається з «• » і має ЩОНАЙБІЛЬШЕ 10 слів.",
    "Кожен пункт — КОНКРЕТНИЙ КЛЮЧОВИЙ РЕЗУЛЬТАТ тижня: яка можливість з'явилась чи покращилась і що це дає (спирайся на resolvedIssueTitles та польові результати).",
    "ЗАБОРОНЕНО: кількість задач, відсотки спринту, внутрішні статуси приймання — це нікого не цікавить.",
    "Числа (години, відео, виїзди) бери ЛИШЕ з наведених нижче даних — нічого не вигадуй.",
    "Відповідай лише рядками-пунктами, без заголовків, вступу чи абзаців.",
    "",
    "Дані тижня (JSON):",
    JSON.stringify(
      {
        period: formatWeekLabel(data.window.start, data.window.end),
        // No flightDays here: it can exceed trips (flights without a formal
        // Звіт) and would read as a contradiction in the bullets.
        field: {
          trips: data.field.reports,
          airHours: data.field.airHours,
          fieldHours: data.field.fieldHours,
        },
        video: data.video,
        resolvedIssueTitles: data.jira.noteworthy.map((n) => n.summary),
      },
      null,
      2,
    ),
  ].join("\n");
}

// -- CSV sidecar ---------------------------------------------------------------

/** Flat one-row CSV (human/spreadsheet record; intentionally lossy). */
export function toInvestorCsv(data: InvestorWeekData): string {
  const header =
    "start,end,jira_resolved,jira_story_points,sprint_rate,field_reports,field_accepted,field_flagged,field_hours,air_hours,video_count,video_minutes,dataset_days";
  const row = [
    data.window.start,
    data.window.end,
    data.jira.resolved,
    data.jira.storyPoints,
    data.sprint ? data.sprint.rate : "",
    data.field.reports,
    data.field.accepted,
    data.field.flagged,
    data.field.fieldHours,
    data.field.airHours,
    data.video.count,
    data.video.minutes,
    data.datasets.noticeDays,
  ].join(",");
  return `${header}\n${row}\n`;
}
