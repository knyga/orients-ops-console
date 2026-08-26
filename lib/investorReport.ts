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
    /** Up to 15 issue titles fed to the summary prompt (never printed as bullets). */
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
    /**
     * Distinct dates with any field activity: telemetry-flew days ∪ real-Звіт
     * days. Never below either count alone — a flight day whose Звіт was not
     * posted (or not parsed) still registers as field activity.
     */
    activeDays: number;
  };
  video: { count: number; minutes: number };
  datasets: { noticeDays: number };
}

/**
 * Metadata about the git grounding fed to the summary call (never the raw
 * diffs — those would bloat the stored record). `error` set = the soft-failed
 * fetch; the report still posted, narrated without git context.
 */
export interface InvestorGitContext {
  prCount: number;
  included: { repo: string; number: number; title: string }[];
  totalChars: number;
  truncated: boolean;
  error?: string;
}

/** The stored record (feature `investor` in the reports table) = the web's render source. */
export interface InvestorRecord {
  data: InvestorWeekData;
  summary: string;
  summarySource: "claude" | "fallback";
  message: string;
  generatedAt: string; // ISO
  /** Absent on records predating the git-grounding feature (2026-08-20). */
  gitContext?: InvestorGitContext;
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

  // Telemetry and Звіти each miss days the other catches (flights without a
  // posted Звіт; a Звіт day with telemetry off) — the union is the honest
  // field-day count.
  const activeDays = new Set([
    ...qaDays.filter((d) => d.flew).map((d) => d.date),
    ...reports.map((d) => d.date),
  ]).size;

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
    field: { reports: reports.length, accepted, flagged, fieldHours, airHours, flightDays, activeDays },
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
 * The completed sprint report belonging to this week: computedAt (the Monday
 * ~09:00 cron, i.e. window.end + 1) falls inside the window, with +2 days of
 * tolerance for late/manual re-runs. Candidates arrive newest-first; first wins.
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
 * The exact #general post: title, then the 3–5 NUMBERED key-result items
 * (Claude or fallback). Items are substantive (up to ~50 words) and carry the
 * week's key figures inline, so there is no separate digits block — that data
 * stays in the stored record for the internal web tab. Investor-facing scope:
 * concrete results, no task/sprint counts, no internal acceptance statuses,
 * no dataset-day counts.
 */
export function formatInvestorMessage(summary: string, data: InvestorWeekData): string {
  return [
    `📊 Тижневий звіт — ${formatWeekLabel(data.window.start, data.window.end)}`,
    "",
    summary.trim(),
  ].join("\n");
}

/** «день/дні/днів» for a count (2–4 → дні, 1/х1 → день, rest → днів). */
function daysWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "день";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "дні";
  return "днів";
}

/** Deterministic numbered key-result items used when the Claude summary call fails. */
export function fallbackSummary(data: InvestorWeekData): string {
  return [
    `1. ${data.field.activeDays} польових ${daysWord(data.field.activeDays)} (${data.field.reports} зі звітами): ${data.field.airHours} год у повітрі, ${data.field.fieldHours} год у полі.`,
    `2. Записано ${data.video.count} відео (${data.video.minutes} хв) для навчання моделей.`,
    `3. Розробка тривала за планом тижня — деталі у внутрішньому дашборді.`,
  ].join("\n");
}

/**
 * Normalize the model's summary into 3–5 NUMBERED lines ("1. …"): accepts
 * numbered or •/-/* line markers, drops everything else, renumbers
 * sequentially, caps at 5. Returns null when no item lines survive (caller
 * falls back to the deterministic items).
 */
export function normalizeSummaryBullets(text: string): string | null {
  const MARKER = /^(?:\d+[.)]|[-*•])\s+/;
  const items = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => MARKER.test(l))
    .map((l) => l.replace(MARKER, ""))
    .filter((l) => l.length > 1)
    .slice(0, 5);
  return items.length ? items.map((l, i) => `${i + 1}. ${l}`).join("\n") : null;
}

/**
 * The one Claude call's prompt: KEY RESULTS only — what capability was
 * delivered/improved and why it matters, drawn from the resolved-issue titles
 * and field outcomes. Task/sprint counts and internal statuses are deliberately
 * NOT in the prompt (investors don't care, and their absence makes «13 із 54
 * задач» bullets impossible). Numbers that ARE passed (hours, videos, flights)
 * may be used but never invented. Output contract: 3–5 «• » bullets, ≤50 words each.
 */
export function buildInvestorPrompt(data: InvestorWeekData, gitGrounding?: string): string {
  return [
    "Ти пишеш короткий тижневий звіт для ангел-інвесторів української оборонної компанії, що розробляє автопілот для FPV-дронів.",
    "Інвестори добре розуміють бойове застосування; пиши ПОМІРНО ТЕХНІЧНО: називай конкретні підсистеми, моделі й механізми (напр. YOLOv8M/N, стабілізація зльоту, наведення камери), але без глибоких нюансів імплементації.",
    "Внутрішні чи вузькотехнічні терміни (golden dataset, назви підсистем, кодові назви гіпотез тощо) при першій згадці поясни в дужках у 3–5 словах — напр. «golden-датасет (еталонний набір для перевірки)». ВИНЯТОК: власні назви наших продуктів (Вартовий тощо) НЕ пояснюй — інвестори їх знають.",
    "Поверни РІВНО 3–5 ПРОНУМЕРОВАНИХ пунктів українською (кожен рядок починається з «1. », «2. » тощо), кожен до 50 слів.",
    "Кожен пункт — КОНКРЕТНИЙ КЛЮЧОВИЙ РЕЗУЛЬТАТ тижня по суті: що саме зроблено, як перевірено, який ефект чи наступний крок (спирайся на resolvedIssueTitles та польові результати).",
    "Ключові цифри тижня (польові дні, години нальоту/у полі, відео) вплети у відповідні пункти — окремого блоку цифр у звіті немає.",
    "Уникай порожніх загальних фраз на кшталт «точніша класифікація цілей» — замість цього скажи, ЩО порівняли/змінили і ЩО це показало.",
    "ЗАБОРОНЕНО: кількість задач, відсотки спринту, внутрішні статуси приймання — це нікого не цікавить.",
    "Числа (години, відео, польові дні) бери ЛИШЕ з наведених нижче даних — нічого не вигадуй.",
    "Відповідай лише рядками-пунктами, без заголовків, вступу чи абзаців.",
    "",
    "Дані тижня (JSON):",
    JSON.stringify(
      {
        period: formatWeekLabel(data.window.start, data.window.end),
        // fieldDays (telemetry ∪ Звіт dates) is the single field-day count the
        // model sees; the Звіт-only trips counter can undercount real field
        // days and is deliberately withheld so the bullets cannot contradict.
        field: {
          fieldDays: data.field.activeDays,
          airHours: data.field.airHours,
          fieldHours: data.field.fieldHours,
        },
        video: data.video,
        resolvedIssueTitles: data.jira.noteworthy.map((n) => n.summary),
      },
      null,
      2,
    ),
    ...(gitGrounding
      ? [
          "",
          "Контекст з GitHub — merged PR-и тижня (опис, коментарі, дифи). Використовуй як ДЖЕРЕЛО ФАКТІВ для конкретики пунктів (що саме змінили і як); нічого поза ним не вигадуй:",
          gitGrounding,
        ]
      : []),
  ].join("\n");
}

// -- CSV sidecar ---------------------------------------------------------------

/** Flat one-row CSV (human/spreadsheet record; intentionally lossy). */
export function toInvestorCsv(data: InvestorWeekData): string {
  const header =
    "start,end,jira_resolved,jira_story_points,sprint_rate,field_reports,field_active_days,field_accepted,field_flagged,field_hours,air_hours,video_count,video_minutes,dataset_days";
  const row = [
    data.window.start,
    data.window.end,
    data.jira.resolved,
    data.jira.storyPoints,
    data.sprint ? data.sprint.rate : "",
    data.field.reports,
    data.field.activeDays,
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
