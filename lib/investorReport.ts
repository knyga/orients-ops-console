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
      noteworthy: input.noteworthy.slice(0, 5),
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

/** The exact #general post: summary paragraph first, then the bullet blocks. */
export function formatInvestorMessage(summary: string, data: InvestorWeekData): string {
  const lines: string[] = [
    `📊 Тижневий звіт для інвесторів — ${formatWeekLabel(data.window.start, data.window.end)}`,
    "",
    summary.trim(),
    "",
    "🛠 Розробка",
    `• Закрито ${data.jira.resolved} задач (${data.jira.storyPoints} стор-поїнтів)`,
  ];
  if (data.sprint) {
    lines.push(
      `• Виконання спринту: ${data.sprint.rate}% (${data.sprint.completed}/${data.sprint.committed})`,
    );
  }
  lines.push(
    "",
    "🚁 Польові роботи",
    // REJECTED reports count toward `reports` (the total) but deliberately fall
    // into neither `accepted` nor `flagged` — spec is accepted vs flagged only.
    `• Виїздів: ${data.field.reports} (прийнято ${data.field.accepted}, на розгляді ${data.field.flagged})`,
    `• Час у полі: ${data.field.fieldHours} год, час у повітрі: ${data.field.airHours} год`,
    "",
    "🎥 Дані",
    `• Відео: ${data.video.count} роликів, ${data.video.minutes} хв записано`,
    `• Датасети: передано за ${data.datasets.noticeDays} дн.`,
  );
  return lines.join("\n");
}

/** Deterministic Ukrainian paragraph used when the Claude summary call fails. */
export function fallbackSummary(data: InvestorWeekData): string {
  return (
    `За тиждень команда закрила ${data.jira.resolved} задач розробки, ` +
    `виконала ${data.field.reports} польових виїздів ` +
    `(${data.field.airHours} год у повітрі) та записала ${data.video.minutes} хв відео. ` +
    `Деталі — у цифрах нижче.`
  );
}

/**
 * The one Claude call's prompt: every figure is passed in; the model narrates,
 * never invents numbers.
 */
export function buildInvestorPrompt(data: InvestorWeekData): string {
  return [
    "Ти пишеш короткий тижневий звіт для ангел-інвесторів української оборонної компанії, що розробляє автопілот для FPV-дронів.",
    "Інвестори добре розуміють бойове застосування, але не технічні нюанси — без жаргону.",
    "Напиши РІВНО один абзац із 3–5 речень українською: що зроблено за тиждень і яку цінність це дає.",
    "Використовуй ЛИШЕ наведені нижче числа — нічого не вигадуй і не додавай нових цифр.",
    "Відповідай лише текстом абзацу, без заголовків і списків.",
    "",
    "Дані тижня (JSON):",
    JSON.stringify(
      {
        period: formatWeekLabel(data.window.start, data.window.end),
        jira: { resolved: data.jira.resolved, storyPoints: data.jira.storyPoints },
        sprint: data.sprint,
        field: data.field,
        video: data.video,
        datasets: data.datasets,
        noteworthyIssues: data.jira.noteworthy.map((n) => n.summary),
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
