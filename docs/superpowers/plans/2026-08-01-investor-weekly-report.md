# Weekly Investor Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-draft a weekly Ukrainian investor report (summary paragraph + bullet blocks) to #general every Tuesday ≈09:00 Kyiv, with a CLI, a cron, a DB-stored artifact, and an Investor web tab.

**Architecture:** Clone of the sprint-report pattern: pure logic in `lib/investorReport.ts` (window math, slicing, rendering — unit-tested), a store on the shared `reports` table (`lib/investorStore.ts`, feature `investor`), server-only orchestration `lib/runInvestor.ts` used by both `scripts/investor.ts` (`npm run investor`, DRY-RUN default) and `/api/cron/investor-report` (vercel.json `0 6 * * 2`). Slack send deduped via an `investor:<key>` outbound key. Web: `GET /api/investor` + `app/(dashboard)/investor/page.tsx`.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Vitest, drizzle (`lib/db.ts` `reports` table), `@anthropic-ai/sdk`, existing `lib/jira.ts` / `lib/vimeo.ts` / `lib/slack.ts` clients.

**Spec:** `docs/superpowers/specs/2026-07-31-investor-weekly-report-design.md`

## Global Constraints

- Every feature ships BOTH a CLI and a web view (CLAUDE.md non-negotiable).
- All team-facing Slack posts are in **Ukrainian**.
- CLI is **DRY-RUN by default**; a real post needs explicit `--publish` AND `--channel <name>` (a tracked channel, `lib/slackChannels.ts`).
- Pure logic lives in `lib/` with unit tests, no React/Next/server imports (same discipline as `lib/reconcile.ts`).
- Server-only modules (`lib/runInvestor.ts`, `lib/investorSummary.ts`) import `"server-only"`; CLIs run Node with `--conditions=react-server` so that import resolves empty.
- The store key is ALWAYS `${start}_${end}` — never `periodKey()`, which collapses a same-month week to `YYYY-MM` and would collide with monthly reports.
- Claude summary soft-fails to a deterministic fallback (still posts). Any data-stage hard failure → no post + best-effort operator DM.
- Cron schedule `0 6 * * 2` (≈09:00 Kyiv summer / 08:00 winter — the accepted fixed-UTC compromise).
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Pure logic — window math, slicing, rendering (`lib/investorReport.ts`)

**Files:**
- Create: `lib/investorReport.ts`
- Test: `lib/investorReport.test.ts`

**Interfaces:**
- Consumes: nothing — deliberately zero imports. The inputs mirror `ReportDay` (`scripts/fieldQaReport.ts`), `DayVerdict` (`lib/fieldDayVerdict.ts`), and `VimeoVideo` (`lib/vimeo.ts`) but are declared as narrow structural types locally (see code), so the pure module stays import-light and the real types remain assignable at the call site (Task 4).
- Produces (later tasks rely on these exact names):
  - `interface WeekWindow { start: string; end: string; key: string }`
  - `computeWeekWindow(today: string): WeekWindow`
  - `monthKeysCovering(window: WeekWindow): string[]`
  - `interface InvestorWeekData` / `interface InvestorRecord` (shapes below)
  - `buildWeekData(input: BuildInput): InvestorWeekData`
  - `pickSprintCompletion(records: SprintPick[], window: WeekWindow): InvestorWeekData["sprint"]`
  - `buildInvestorPrompt(data: InvestorWeekData): string`
  - `fallbackSummary(data: InvestorWeekData): string`
  - `formatWeekLabel(start: string, end: string): string`
  - `formatInvestorMessage(summary: string, data: InvestorWeekData): string`
  - `toInvestorCsv(data: InvestorWeekData): string`

- [ ] **Step 1: Write the failing tests**

Create `lib/investorReport.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  buildInvestorPrompt,
  buildWeekData,
  computeWeekWindow,
  fallbackSummary,
  formatInvestorMessage,
  formatWeekLabel,
  monthKeysCovering,
  pickSprintCompletion,
  toInvestorCsv,
  type InvestorWeekData,
} from "./investorReport";

// -- fixtures ---------------------------------------------------------------

const DATA: InvestorWeekData = {
  window: { start: "2026-07-20", end: "2026-07-26", key: "2026-07-20_2026-07-26" },
  jira: {
    resolved: 12,
    storyPoints: 34,
    noteworthy: [{ key: "ATP-101", summary: "Автопілот: утримання висоти" }],
  },
  sprint: { name: "ATP 42", rate: 80, completed: 8, committed: 10 },
  field: { reports: 3, accepted: 2, flagged: 1, fieldHours: 14.5, airHours: 6.2, flightDays: 3 },
  video: { count: 9, minutes: 187 },
  datasets: { noticeDays: 2 },
};

describe("computeWeekWindow", () => {
  it("returns the previous Mon–Sun for a mid-week Tuesday", () => {
    expect(computeWeekWindow("2026-08-04")).toEqual({
      start: "2026-07-27",
      end: "2026-08-02",
      key: "2026-07-27_2026-08-02",
    });
  });

  it("on a Monday returns the week that ended yesterday", () => {
    expect(computeWeekWindow("2026-08-03")).toEqual({
      start: "2026-07-27",
      end: "2026-08-02",
      key: "2026-07-27_2026-08-02",
    });
  });

  it("on a Sunday returns the previous full week, not the ending one", () => {
    // Sunday 2026-08-09: current week (Aug 3–9) is not over yet.
    expect(computeWeekWindow("2026-08-09").end).toBe("2026-08-02");
  });

  it("handles a year boundary", () => {
    // Tuesday 2027-01-05 → previous week Mon 2026-12-28 .. Sun 2027-01-03.
    expect(computeWeekWindow("2027-01-05")).toEqual({
      start: "2026-12-28",
      end: "2027-01-03",
      key: "2026-12-28_2027-01-03",
    });
  });

  it("never collapses the key to YYYY-MM even inside one month", () => {
    // Tue 2026-07-14 → Mon 2026-07-06 .. Sun 2026-07-12, same month.
    expect(computeWeekWindow("2026-07-14").key).toBe("2026-07-06_2026-07-12");
  });
});

describe("monthKeysCovering", () => {
  it("returns one month for an in-month week", () => {
    expect(monthKeysCovering({ start: "2026-07-06", end: "2026-07-12", key: "x" }))
      .toEqual(["2026-07"]);
  });
  it("returns both months for a straddling week", () => {
    expect(monthKeysCovering({ start: "2026-07-27", end: "2026-08-02", key: "x" }))
      .toEqual(["2026-07", "2026-08"]);
  });
});

describe("formatWeekLabel", () => {
  it("renders an in-month week compactly", () => {
    expect(formatWeekLabel("2026-07-20", "2026-07-26")).toBe("20–26 липня 2026");
  });
  it("renders a cross-month week with both months", () => {
    expect(formatWeekLabel("2026-07-27", "2026-08-02")).toBe("27 липня – 2 серпня 2026");
  });
  it("renders a cross-year week with both years", () => {
    expect(formatWeekLabel("2026-12-28", "2027-01-03")).toBe("28 грудня 2026 – 3 січня 2027");
  });
});

describe("buildWeekData", () => {
  const window = { start: "2026-07-20", end: "2026-07-26", key: "2026-07-20_2026-07-26" };

  it("slices field rows to the window and aggregates", () => {
    const data = buildWeekData({
      window,
      jiraTotals: { totalResolved: 12, totalStoryPoints: 34 },
      noteworthy: [{ key: "ATP-101", summary: "Автопілот" }],
      sprint: null,
      fieldQaDays: [
        { date: "2026-07-19", airborneMinutes: 999, flew: true },  // before window — dropped
        { date: "2026-07-21", airborneMinutes: 120, flew: true },
        { date: "2026-07-22", airborneMinutes: 252, flew: true },
        { date: "2026-07-23", airborneMinutes: 0, flew: false },   // no flight — not a flight day
      ],
      verdictDays: [
        { date: "2026-07-21", reportTs: "1.1", status: "ACCEPTED", datasetStatus: "POSTED", deployMin: 480, hasZvit: true },
        { date: "2026-07-22", reportTs: "2.1", status: "ACCEPTED_EXCEPTION", datasetStatus: "POSTED", deployMin: 240, hasZvit: true },
        { date: "2026-07-22", reportTs: "2.2", status: "NEEDS_REVIEW", datasetStatus: "POSTED", deployMin: 150, hasZvit: true },
        { date: "2026-07-27", reportTs: "9.9", status: "ACCEPTED", datasetStatus: "POSTED", deployMin: 480, hasZvit: true }, // after window — dropped
      ],
      videos: [{ duration: 600 }, { duration: 300 }],
    });

    expect(data.field).toEqual({
      reports: 3,
      accepted: 2,     // ACCEPTED + ACCEPTED_EXCEPTION
      flagged: 1,      // NEEDS_REVIEW (PENDING would count too)
      fieldHours: 14.5, // (480+240+150)/60
      airHours: 6.2,    // (120+252)/60
      flightDays: 2,
    });
    expect(data.video).toEqual({ count: 2, minutes: 15 });
    expect(data.datasets.noticeDays).toBe(2); // 07-21 and 07-22, per-date dedupe
  });

  it("ignores synthetic no-Звіт rows and null deployMin in the field-hours sum", () => {
    const data = buildWeekData({
      window,
      jiraTotals: { totalResolved: 0, totalStoryPoints: 0 },
      noteworthy: [],
      sprint: null,
      fieldQaDays: [],
      verdictDays: [
        { date: "2026-07-21", reportTs: null, status: "NEEDS_REVIEW", datasetStatus: "MISSING", deployMin: null, hasZvit: false },
        { date: "2026-07-22", reportTs: "3.1", status: "PENDING", datasetStatus: "MISSING", deployMin: null, hasZvit: true },
      ],
      videos: [],
    });
    expect(data.field.reports).toBe(1);      // hasZvit false excluded
    expect(data.field.flagged).toBe(1);      // PENDING counts as flagged
    expect(data.field.fieldHours).toBe(0);   // null deployMin contributes nothing
    expect(data.datasets.noticeDays).toBe(0);
  });
});

describe("pickSprintCompletion", () => {
  const window = { start: "2026-07-20", end: "2026-07-26", key: "k" };
  it("picks the newest completed sprint whose computedAt falls in the window (+2d tolerance)", () => {
    const picked = pickSprintCompletion(
      [
        { name: "ATP 43", computedAt: "2026-08-02T20:00:00Z", rate: 50, completed: 5, committed: 10 },
        { name: "ATP 42", computedAt: "2026-07-26T20:00:00Z", rate: 80, completed: 8, committed: 10 },
      ],
      window,
    );
    expect(picked).toEqual({ name: "ATP 42", rate: 80, completed: 8, committed: 10 });
  });
  it("returns null when nothing matches", () => {
    expect(pickSprintCompletion([], window)).toBeNull();
  });
});

describe("formatInvestorMessage", () => {
  it("puts the summary first, then the three bullet blocks", () => {
    const msg = formatInvestorMessage("Гарний тиждень.", DATA);
    expect(msg).toContain("📊 Тижневий звіт для інвесторів — 20–26 липня 2026");
    expect(msg.indexOf("Гарний тиждень.")).toBeLessThan(msg.indexOf("🛠 Розробка"));
    expect(msg).toContain("• Закрито 12 задач (34 стор-поїнтів)");
    expect(msg).toContain("• Виконання спринту: 80% (8/10)");
    expect(msg).toContain("🚁 Польові роботи");
    expect(msg).toContain("• Виїздів: 3 (прийнято 2, на розгляді 1)");
    expect(msg).toContain("• Час у полі: 14.5 год, час у повітрі: 6.2 год");
    expect(msg).toContain("🎥 Дані");
    expect(msg).toContain("• Відео: 9 роликів, 187 хв записано");
    expect(msg).toContain("• Датасети: передано за 2 дн.");
  });

  it("omits the sprint line when sprint is null and shows an honest zero-field week", () => {
    const data: InvestorWeekData = {
      ...DATA,
      sprint: null,
      field: { reports: 0, accepted: 0, flagged: 0, fieldHours: 0, airHours: 0, flightDays: 0 },
    };
    const msg = formatInvestorMessage("X.", data);
    expect(msg).not.toContain("Виконання спринту");
    expect(msg).toContain("• Виїздів: 0");
  });
});

describe("fallbackSummary / buildInvestorPrompt", () => {
  it("fallback mentions the headline numbers", () => {
    const s = fallbackSummary(DATA);
    expect(s).toContain("12");
    expect(s).toContain("3");
  });
  it("prompt embeds the numbers and the noteworthy issue titles", () => {
    const p = buildInvestorPrompt(DATA);
    expect(p).toContain('"resolved": 12');
    expect(p).toContain("Автопілот: утримання висоти");
  });
});

describe("toInvestorCsv", () => {
  it("emits one header + one data row", () => {
    const lines = toInvestorCsv(DATA).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      "start,end,jira_resolved,jira_story_points,sprint_rate,field_reports,field_accepted,field_flagged,field_hours,air_hours,video_count,video_minutes,dataset_days",
    );
    expect(lines[1]).toBe("2026-07-20,2026-07-26,12,34,80,3,2,1,14.5,6.2,9,187,2");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/investorReport.test.ts`
Expected: FAIL — `Cannot find module './investorReport'` (or equivalent).

- [ ] **Step 3: Write the implementation**

Create `lib/investorReport.ts`:

```typescript
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
```

Note the test's prompt assertion `'"resolved": 12'` relies on the 2-space JSON.stringify above.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/investorReport.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add lib/investorReport.ts lib/investorReport.test.ts
git commit -m "feat(investor): pure weekly-report logic (window, slicing, Ukrainian render)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Store + outbound key (`lib/investorStore.ts`, `lib/outboundKeys.ts`)

**Files:**
- Create: `lib/investorStore.ts`
- Modify: `lib/outboundKeys.ts` (append one builder near the sprint keys, around line 74)
- Test: `lib/investorStore.test.ts` (key-shape only — the DB wrapper mirrors `sprintStore.ts`, which ships untested; we test the one piece with logic)

**Interfaces:**
- Consumes: `db`, `schema` from `lib/db.ts`; `InvestorRecord` from Task 1.
- Produces:
  - `readInvestor(key: string): Promise<InvestorRecord | null>`
  - `writeInvestor(key: string, record: InvestorRecord, csv: string): Promise<void>`
  - `listInvestorKeys(): Promise<string[]>` (newest first by period desc)
  - `investorKey(periodKey: string): string` in `lib/outboundKeys.ts` → `` `investor:${periodKey}` ``

- [ ] **Step 1: Write the failing test**

Create `lib/investorStore.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { investorKey } from "./outboundKeys";

describe("investorKey", () => {
  it("namespaces the send by the explicit week key", () => {
    expect(investorKey("2026-07-20_2026-07-26")).toBe("investor:2026-07-20_2026-07-26");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/investorStore.test.ts`
Expected: FAIL — `investorKey` is not exported.

- [ ] **Step 3: Implement**

Append to `lib/outboundKeys.ts` (next to `sprintCommittedKey`/`sprintCompletedKey`):

```typescript
/** Weekly investor report post, keyed by the explicit Mon_Sun week key. */
export const investorKey = (periodKey: string): string => `investor:${periodKey}`;
```

Create `lib/investorStore.ts`:

```typescript
/**
 * Store for the weekly investor report, on the shared `reports` table
 * (feature = "investor", period = the explicit `${start}_${end}` week key —
 * NEVER the collapsed monthly periodKey, which would collide with monthly
 * features). Mirrors lib/sprintStore.ts. Deliberately NOT `server-only`:
 * no secrets, imported by both the API route and the Node CLI.
 */
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "./db";
import type { InvestorRecord } from "./investorReport";

const FEATURE = "investor";

/** Read one week's record by key, or null when absent. */
export async function readInvestor(key: string): Promise<InvestorRecord | null> {
  const rows = await db
    .select()
    .from(schema.reports)
    .where(and(eq(schema.reports.feature, FEATURE), eq(schema.reports.period, key)))
    .limit(1);
  return rows.length ? (rows[0].json as InvestorRecord) : null;
}

/** Upsert one week's record (+ flat CSV sidecar) by key. */
export async function writeInvestor(
  key: string,
  record: InvestorRecord,
  csv: string,
): Promise<void> {
  const values = {
    feature: FEATURE,
    period: key,
    json: record,
    csv,
    updatedAt: new Date().toISOString(),
  };
  await db
    .insert(schema.reports)
    .values(values)
    .onConflictDoUpdate({ target: [schema.reports.feature, schema.reports.period], set: values });
}

/** Week keys with a stored record, newest first. */
export async function listInvestorKeys(): Promise<string[]> {
  const rows = await db
    .select({ period: schema.reports.period })
    .from(schema.reports)
    .where(eq(schema.reports.feature, FEATURE))
    .orderBy(desc(schema.reports.period));
  return rows.map((r) => r.period);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/investorStore.test.ts lib/outboundKeys.test.ts`
Expected: PASS (including the existing outboundKeys suite — no regressions).

- [ ] **Step 5: Commit**

```bash
git add lib/investorStore.ts lib/investorStore.test.ts lib/outboundKeys.ts
git commit -m "feat(investor): reports-table store + outbound dedup key

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Claude summary call (`lib/investorSummary.ts`)

**Files:**
- Create: `lib/investorSummary.ts`

**Interfaces:**
- Consumes: `buildInvestorPrompt`, `fallbackSummary`, `InvestorWeekData` from Task 1.
- Produces: `generateSummary(data: InvestorWeekData): Promise<{ text: string; source: "claude" | "fallback" }>` — NEVER throws; every failure path (missing key, API error, refusal, empty text) degrades to the fallback.

No unit test: the prompt builder and fallback are already tested in Task 1; this module is thin I/O glue mirroring `lib/summarize.ts` (also untested).

- [ ] **Step 1: Implement**

Create `lib/investorSummary.ts`:

```typescript
/**
 * The one Claude call that narrates the week's numbers into the investor
 * summary paragraph. SERVER-ONLY (needs ANTHROPIC_API_KEY). Soft-fails by
 * design: any error returns the deterministic fallback — the weekly draft is
 * human-edited in #general anyway, so a degraded summary must never block it.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { buildInvestorPrompt, fallbackSummary, type InvestorWeekData } from "./investorReport";

const MODEL = "claude-sonnet-5";

export async function generateSummary(
  data: InvestorWeekData,
): Promise<{ text: string; source: "claude" | "fallback" }> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { text: fallbackSummary(data), source: "fallback" };
  }
  try {
    const client = new Anthropic();
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: buildInvestorPrompt(data) }],
    });
    if (message.stop_reason === "refusal") {
      return { text: fallbackSummary(data), source: "fallback" };
    }
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) return { text: fallbackSummary(data), source: "fallback" };
    return { text, source: "claude" };
  } catch (err) {
    console.error("investorSummary: Claude call failed, using fallback:", err);
    return { text: fallbackSummary(data), source: "fallback" };
  }
}
```

- [ ] **Step 2: Type-check and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean (no errors in the new file).

- [ ] **Step 3: Commit**

```bash
git add lib/investorSummary.ts
git commit -m "feat(investor): Claude summary call with deterministic fallback

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Orchestration (`lib/runInvestor.ts`)

**Files:**
- Create: `lib/runInvestor.ts`

**Interfaces:**
- Consumes:
  - Task 1: `computeWeekWindow`, `monthKeysCovering`, `buildWeekData`, `pickSprintCompletion`, `formatInvestorMessage`, `toInvestorCsv`, types.
  - Task 2: `writeInvestor`; `investorKey` from `lib/outboundKeys.ts`.
  - Task 3: `generateSummary`.
  - Existing: `fetchResolvedIssues` (`lib/jira.ts`), `aggregateByUser` (`lib/jiraStats.ts`), `fetchVideosInPeriod` (`lib/vimeo.ts`), `readReportJson` (`lib/reports.ts`), `listSprintSlugs`/`readSprint` (`lib/sprintStore.ts`), `postMessage`/`openDm` (`lib/slack.ts`), `TRACKED_CHANNELS` (`lib/slackChannels.ts`), `todayInFieldTz` (`lib/syncChannels.ts`), `APPROVERS` (`lib/approvers.ts`), `SendTrigger` (`lib/outboundKeys.ts`).
- Produces (CLI + cron rely on these exact shapes):

```typescript
export interface RunInvestorOptions {
  publish: boolean;
  channelName?: string; // tracked channel NAME, default "general"
  today?: string;       // YYYY-MM-DD override for tests/backfill
  trigger?: SendTrigger;
}
export type InvestorResult =
  | { status: "ok"; key: string; message: string; posted: boolean; summarySource: "claude" | "fallback" }
  | { status: "failed"; stage: "jira" | "sprint" | "field" | "vimeo" | "store"; reason: string };
export async function runInvestor(opts: RunInvestorOptions): Promise<InvestorResult>
```

- [ ] **Step 1: Implement**

Create `lib/runInvestor.ts`:

```typescript
/**
 * Shared weekly-investor-report orchestration, used by BOTH the `npm run
 * investor` CLI and the `/api/cron/investor-report` route (mirrors
 * lib/runSprint.ts). Gathers the previous Mon–Sun week's numbers (Jira live,
 * sprint completion from the sprint store, field-qa/field-verdict from the
 * DB monthly reports, Vimeo live), narrates them via one soft-failing Claude
 * call, stores the record (feature "investor"), and — when publishing — posts
 * the Ukrainian draft to #general via the lib/slack.ts reserve-then-send
 * chokepoint (outbound key `investor:<week>`, so a cron re-fire posts once).
 *
 * Hard failure in any data stage → NO post + best-effort operator DM (the
 * draft must never ship on partial data). A failed Claude summary is soft —
 * the deterministic fallback still posts (humans edit the draft anyway).
 */
import "server-only";
import { APPROVERS } from "./approvers";
import type { DayVerdict } from "./fieldDayVerdict";
import {
  buildWeekData,
  computeWeekWindow,
  formatInvestorMessage,
  monthKeysCovering,
  pickSprintCompletion,
  toInvestorCsv,
  type InvestorRecord,
  type SprintPick,
} from "./investorReport";
import { writeInvestor } from "./investorStore";
import { generateSummary } from "./investorSummary";
import { fetchResolvedIssues } from "./jira";
import { aggregateByUser } from "./jiraStats";
import { investorKey, type SendTrigger } from "./outboundKeys";
import { readReportJson } from "./reports";
import { openDm, postMessage } from "./slack";
import { TRACKED_CHANNELS } from "./slackChannels";
import { listSprintSlugs, readSprint } from "./sprintStore";
import { todayInFieldTz } from "./syncChannels";
import { fetchVideosInPeriod } from "./vimeo";

export interface RunInvestorOptions {
  publish: boolean;
  /** Tracked channel NAME to post to (default "general"). */
  channelName?: string;
  /** Kyiv-date override for tests/backfill (default: today in Kyiv). */
  today?: string;
  trigger?: SendTrigger;
}

export type InvestorResult =
  | {
      status: "ok";
      key: string;
      message: string;
      posted: boolean;
      summarySource: "claude" | "fallback";
    }
  | { status: "failed"; stage: "jira" | "sprint" | "field" | "vimeo" | "store"; reason: string };

interface FieldQaMonth {
  days: { date: string; airborneMinutes: number; flew: boolean }[];
}
interface VerdictMonth {
  days: DayVerdict[];
}

/** Best-effort operator DM; a failed DM must not mask the original error. */
async function notifyOperator(stage: string, reason: string): Promise<void> {
  try {
    const dm = await openDm(APPROVERS[0].userId);
    await postMessage(dm, `⛔ Тижневий звіт для інвесторів не сформовано (${stage}): ${reason}`, {
      key: `investor-failure:${stage}:${reason.slice(0, 40)}`,
      feature: "investor-failure",
      channel: "dm",
      trigger: "cron",
    });
  } catch (e) {
    console.error("runInvestor: operator DM failed:", e);
  }
}

export async function runInvestor(opts: RunInvestorOptions): Promise<InvestorResult> {
  const today = opts.today ?? todayInFieldTz();
  const window = computeWeekWindow(today);
  const channelName = opts.channelName ?? "general";

  const fail = async (
    stage: "jira" | "sprint" | "field" | "vimeo" | "store",
    err: unknown,
  ): Promise<InvestorResult> => {
    const reason = err instanceof Error ? err.message : String(err);
    if (opts.publish) await notifyOperator(stage, reason);
    return { status: "failed", stage, reason };
  };

  // 1. Jira delivery (live).
  let jiraTotals: { totalResolved: number; totalStoryPoints: number };
  let noteworthy: { key: string; summary: string }[];
  try {
    const issues = await fetchResolvedIssues(window.start, window.end);
    jiraTotals = aggregateByUser(issues).totals;
    noteworthy = issues.slice(0, 5).map((i) => ({ key: i.key, summary: i.summary }));
  } catch (e) {
    return fail("jira", e);
  }

  // 2. Sprint completion (from the sprint store; absent → line omitted).
  let sprint: ReturnType<typeof pickSprintCompletion>;
  try {
    const slugs = (await listSprintSlugs()).slice(0, 6);
    const picks: SprintPick[] = [];
    for (const slug of slugs) {
      const rec = await readSprint(slug);
      if (rec?.completed) {
        picks.push({
          name: rec.committed.sprintName,
          computedAt: rec.completed.computedAt,
          rate: rec.completed.result.rate,
          completed: rec.completed.result.completed,
          committed: rec.completed.result.committed,
        });
      }
    }
    sprint = pickSprintCompletion(picks, window);
  } catch (e) {
    return fail("sprint", e);
  }

  // 3. Field data from the DB monthly reports (absent month row → no field
  //    activity recorded — legitimate; a thrown read is a hard fail).
  let fieldQaDays: FieldQaMonth["days"] = [];
  let verdictDays: DayVerdict[] = [];
  try {
    for (const monthKey of monthKeysCovering(window)) {
      const fq = await readReportJson<FieldQaMonth>("field-qa", monthKey);
      if (fq?.days) fieldQaDays = fieldQaDays.concat(fq.days);
      const vr = await readReportJson<VerdictMonth>("field-verdict", monthKey);
      if (vr?.days) verdictDays = verdictDays.concat(vr.days);
    }
  } catch (e) {
    return fail("field", e);
  }

  // 4. Video (live Vimeo).
  let videos: { duration: number }[];
  try {
    videos = await fetchVideosInPeriod(window.start, window.end);
  } catch (e) {
    return fail("vimeo", e);
  }

  const data = buildWeekData({
    window,
    jiraTotals,
    noteworthy,
    sprint,
    fieldQaDays,
    verdictDays,
    videos,
  });

  // 5. Summary (soft-fail → deterministic fallback inside generateSummary).
  const summary = await generateSummary(data);
  const message = formatInvestorMessage(summary.text, data);

  const record: InvestorRecord = {
    data,
    summary: summary.text,
    summarySource: summary.source,
    message,
    generatedAt: new Date().toISOString(),
  };

  // 6. Store (both dry-run and publish — the web tab renders the latest record).
  try {
    await writeInvestor(window.key, record, toInvestorCsv(data));
  } catch (e) {
    return fail("store", e);
  }

  // 7. Post (publish only; deduped by the week key at the slack chokepoint).
  let posted = false;
  if (opts.publish) {
    const channel = TRACKED_CHANNELS.find((c) => c.name === channelName);
    if (!channel) return fail("store", new Error(`unknown tracked channel "${channelName}"`));
    await postMessage(channel.id, message, {
      key: investorKey(window.key),
      feature: "investor",
      channel: channel.name,
      trigger: opts.trigger ?? "unknown",
    });
    posted = true;
  }

  return { status: "ok", key: window.key, message, posted, summarySource: summary.source };
}
```

- [ ] **Step 2: Type-check, lint, full test suite**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: clean; no existing tests broken.

- [ ] **Step 3: Commit**

```bash
git add lib/runInvestor.ts
git commit -m "feat(investor): shared run orchestration (gather, summarize, store, post)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: CLI (`scripts/investor.ts` + npm script)

**Files:**
- Create: `scripts/investor.ts`
- Modify: `package.json` (add `"investor"` to `scripts`, after the `"sprint"` line)

**Interfaces:**
- Consumes: `runInvestor`, `RunInvestorOptions` from Task 4; `TRACKED_CHANNELS` from `lib/slackChannels.ts`.
- Produces: `npm run investor -- [--publish --channel <name>] [--today YYYY-MM-DD] [--format json]`.

- [ ] **Step 1: Implement the CLI**

Create `scripts/investor.ts`:

```typescript
/**
 * CLI: weekly investor report — DRY-RUN BY DEFAULT. The terminal twin of the
 * /api/cron/investor-report Vercel cron; both call lib/runInvestor.
 *
 * Usage:
 *   npm run investor                                     # dry-run: compute + store + print the Ukrainian post
 *   npm run investor -- --today 2026-08-04               # dry-run for another week's Tuesday
 *   npm run investor -- --format json                    # dry-run, print the stored record as JSON
 *   npm run investor -- --publish --channel general      # ACTUALLY POST to #general (needs chat:write)
 *
 * Safety:
 *  - Dry-run is the default; a real post requires the explicit `--publish` flag.
 *  - `--publish` REQUIRES `--channel <name>` (a tracked channel) — no default target.
 *
 * Runs under `--conditions=react-server` so the server-only imports resolve.
 */
import { TRACKED_CHANNELS } from "../lib/slackChannels";
import { runInvestor } from "../lib/runInvestor";

interface Args {
  publish: boolean;
  channel?: string;
  today?: string;
  format: "text" | "json";
}

function parseArgs(argv: string[]): Args {
  const args: Args = { publish: false, format: "text" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--publish") args.publish = true;
    else if (a === "--channel") args.channel = argv[++i];
    else if (a === "--today") args.today = argv[++i];
    else if (a === "--format") args.format = argv[++i] === "json" ? "json" : "text";
  }
  return args;
}

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* rely on ambient env */ }

  const args = parseArgs(process.argv.slice(2));

  if (args.publish) {
    if (!args.channel) {
      process.stderr.write("investor: --publish requires --channel <name> (no default target).\n");
      process.exit(1);
    }
    if (!TRACKED_CHANNELS.some((c) => c.name === args.channel)) {
      process.stderr.write(
        `investor: unknown channel "${args.channel}" (tracked: ${TRACKED_CHANNELS.map((c) => c.name).join(", ")}).\n`,
      );
      process.exit(1);
    }
  }

  const result = await runInvestor({
    publish: args.publish,
    channelName: args.channel,
    today: args.today,
    trigger: "cli",
  });

  if (result.status === "failed") {
    process.stderr.write(`investor: FAILED at ${result.stage}: ${result.reason}\n`);
    process.exit(1);
  }

  if (args.format === "json") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`--- week ${result.key} (summary: ${result.summarySource}) ---\n\n`);
  process.stdout.write(`${result.message}\n\n`);
  process.stdout.write(
    result.posted ? "POSTED.\n" : "DRY-RUN — nothing posted (use --publish --channel <name>).\n",
  );
}

main().catch((err) => {
  process.stderr.write(`investor: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm script**

In `package.json` `scripts`, after the `"sprint"` entry, add:

```json
"investor": "node --conditions=react-server --import tsx scripts/investor.ts",
```

- [ ] **Step 3: Verify the dry run end-to-end**

Run: `npm run investor -- --today 2026-08-04`
Expected: prints `--- week 2026-07-27_2026-08-02 ... ---`, the full Ukrainian message (summary paragraph, then 🛠/🚁/🎥 blocks), and `DRY-RUN — nothing posted`. (Needs `.env` with `JIRA_*`, `VIMEO_TOKEN`, `POSTGRES_URL`; without `ANTHROPIC_API_KEY` the summary line says `fallback` — still a pass.)

If it fails on missing env, report which stage failed — that's the guardrail working; verify the error names the stage and exits 1.

- [ ] **Step 4: Commit**

```bash
git add scripts/investor.ts package.json
git commit -m "feat(investor): npm run investor CLI (dry-run default)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Cron route + schedule

**Files:**
- Create: `app/api/cron/investor-report/route.ts`
- Modify: `vercel.json` (add one cron entry)

**Interfaces:**
- Consumes: `isAuthorizedCron` (`lib/cronAuth.ts`), `runInvestor` (Task 4).
- Produces: `GET /api/cron/investor-report` (Bearer `CRON_SECRET`).

- [ ] **Step 1: Implement the route**

Create `app/api/cron/investor-report/route.ts`:

```typescript
/**
 * Vercel Cron: Tuesday 06:00 UTC (≈09:00 Kyiv summer / 08:00 winter — the same
 * fixed-UTC compromise as the other crons) — draft the weekly investor report
 * for the previous Mon–Sun week and post it to #general. The post is an
 * INTERNAL DRAFT the team edits before forwarding to investors. Guarded by
 * CRON_SECRET. Any data-stage failure skips the post and DMs the operator;
 * a re-fire dedups on the `investor:<week>` outbound key.
 */
import { isAuthorizedCron } from "@/lib/cronAuth";
import { runInvestor } from "@/lib/runInvestor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorizedCron(req)) return new Response("unauthorized", { status: 401 });
  const result = await runInvestor({ publish: true, channelName: "general", trigger: "cron" });
  return Response.json({ ok: result.status === "ok", ...result }, { status: 200 });
}
```

- [ ] **Step 2: Add the schedule**

In `vercel.json`, add to `crons` (after the sprint-report entry):

```json
{ "path": "/api/cron/investor-report", "schedule": "0 6 * * 2" }
```

- [ ] **Step 3: Verify build**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add app/api/cron/investor-report/route.ts vercel.json
git commit -m "feat(investor): Tuesday 06:00 UTC cron posting the weekly draft

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Web — API route + Investor tab

**Files:**
- Create: `app/api/investor/route.ts`
- Create: `app/(dashboard)/investor/page.tsx`
- Modify: `app/(dashboard)/layout.tsx` (add nav tab)

**Interfaces:**
- Consumes: `listInvestorKeys`, `readInvestor` (Task 2); `InvestorRecord` shape (Task 1).
- Produces: `GET /api/investor?periods=1` → `{ keys: string[] }`; `GET /api/investor?period=<key>` → `InvestorRecord` (404 absent, 400 missing param).

- [ ] **Step 1: Implement the API route**

Create `app/api/investor/route.ts` (mirrors `app/api/sprint/route.ts`; the dashboard auth proxy gates `/api/*` data routes automatically):

```typescript
import { NextResponse } from "next/server";
import { listInvestorKeys, readInvestor } from "@/lib/investorStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/investor?periods=1      → { keys: string[] } (newest first)
 * GET /api/investor?period=<key>   → the stored InvestorRecord (404 when absent)
 *
 * Read-only view of the committed weekly investor reports (feature "investor"
 * in the reports table). The web never writes — the CLI/cron is the writer.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  if (searchParams.get("periods")) {
    return NextResponse.json({ keys: await listInvestorKeys() });
  }

  const period = searchParams.get("period");
  if (!period) {
    return NextResponse.json(
      { error: "Provide `period=<start_end>` or `periods=1` to list." },
      { status: 400 },
    );
  }
  const record = await readInvestor(period);
  if (!record) {
    return NextResponse.json({ error: `No investor report "${period}".` }, { status: 404 });
  }
  return NextResponse.json(record);
}
```

- [ ] **Step 2: Implement the page**

Create `app/(dashboard)/investor/page.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";

interface InvestorWeekData {
  window: { start: string; end: string; key: string };
  jira: { resolved: number; storyPoints: number; noteworthy: { key: string; summary: string }[] };
  sprint: { name: string; rate: number; completed: number; committed: number } | null;
  field: { reports: number; accepted: number; flagged: number; fieldHours: number; airHours: number; flightDays: number };
  video: { count: number; minutes: number };
  datasets: { noticeDays: number };
}
interface InvestorRecord {
  data: InvestorWeekData;
  summary: string;
  summarySource: "claude" | "fallback";
  message: string;
  generatedAt: string;
}

export default function InvestorPage() {
  const [keys, setKeys] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [record, setRecord] = useState<InvestorRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/investor?periods=1")
      .then((r) => r.json())
      .then((body: { keys: string[] }) => {
        setKeys(body.keys);
        if (body.keys.length) setSelected(body.keys[0]);
      })
      .catch(() => setError("Failed to list report weeks."));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    setError(null);
    fetch(`/api/investor?period=${encodeURIComponent(selected)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
        return r.json() as Promise<InvestorRecord>;
      })
      .then(setRecord)
      .catch((e) => { setRecord(null); setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => setLoading(false));
  }, [selected]);

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center gap-3 mb-4">
        <h1 className="text-xl font-semibold">Investor weekly</h1>
        <select
          className="border rounded px-2 py-1 text-sm"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          {keys.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
      </div>

      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}
      {loading && <p className="text-sm text-gray-500">Loading…</p>}
      {!keys.length && !error && (
        <p className="text-sm text-gray-500">
          No weekly reports yet — the Tuesday cron (or `npm run investor`) writes the first one.
        </p>
      )}

      {record && (
        <>
          <p className="text-xs text-gray-500 mb-2">
            Generated {record.generatedAt.slice(0, 16).replace("T", " ")} · summary:{" "}
            {record.summarySource}
          </p>
          <pre className="whitespace-pre-wrap rounded border bg-gray-50 p-4 text-sm leading-relaxed">
            {record.message}
          </pre>

          <h2 className="mt-6 mb-2 font-medium text-sm">Raw numbers</h2>
          <table className="text-sm border-collapse">
            <tbody>
              <tr><td className="pr-4 py-0.5 text-gray-500">Jira resolved / SP</td><td>{record.data.jira.resolved} / {record.data.jira.storyPoints}</td></tr>
              <tr><td className="pr-4 py-0.5 text-gray-500">Sprint</td><td>{record.data.sprint ? `${record.data.sprint.name}: ${record.data.sprint.rate}% (${record.data.sprint.completed}/${record.data.sprint.committed})` : "—"}</td></tr>
              <tr><td className="pr-4 py-0.5 text-gray-500">Виїзди (accepted / flagged)</td><td>{record.data.field.reports} ({record.data.field.accepted} / {record.data.field.flagged})</td></tr>
              <tr><td className="pr-4 py-0.5 text-gray-500">Field / air hours</td><td>{record.data.field.fieldHours} / {record.data.field.airHours}</td></tr>
              <tr><td className="pr-4 py-0.5 text-gray-500">Video</td><td>{record.data.video.count} videos, {record.data.video.minutes} min</td></tr>
              <tr><td className="pr-4 py-0.5 text-gray-500">Dataset days</td><td>{record.data.datasets.noticeDays}</td></tr>
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add the nav tab**

In `app/(dashboard)/layout.tsx`, add to `TABS` (after the `/sprint` entry):

```typescript
{ href: "/investor", label: "Investor", enabled: true },
```

- [ ] **Step 4: Verify build**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: all clean/green.

- [ ] **Step 5: Commit**

```bash
git add app/api/investor/route.ts "app/(dashboard)/investor/page.tsx" "app/(dashboard)/layout.tsx"
git commit -m "feat(investor): GET /api/investor + Investor dashboard tab

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Docs + final verification

**Files:**
- Modify: `CLAUDE.md` (add one command bullet, after the `npm run sprint` bullet)

**Interfaces:** none (docs).

- [ ] **Step 1: Document the command in CLAUDE.md**

Insert after the `npm run sprint` bullet:

```markdown
- `npm run investor -- [--publish --channel general] [--today YYYY-MM-DD] [--format json]` — the **weekly investor report**: previous Mon–Sun Kyiv week's Jira delivery (+ sprint completion %), field ops (виїзди, time in field/air, accepted vs flagged), video + dataset numbers, narrated into a Ukrainian summary-first draft by one soft-failing Claude call (fallback template on failure). **DRY-RUN by default** (computes + stores feature `investor`, key `<start>_<end>` — deliberately never the collapsed monthly `periodKey` — posts nothing); `--publish` requires `--channel <name>`. CLI mirror of `/api/cron/investor-report` (`0 6 * * 2` ≈ Tue 09:00 Kyiv summer); shared logic in `lib/runInvestor.ts`; post deduped by `investor:<week>`; the #general post is an **internal draft** the team edits before forwarding to investors. Backs the **Investor** web tab (`GET /api/investor`). Hard data-stage failure → no post + operator DM. Needs `JIRA_*`, `VIMEO_TOKEN`, `POSTGRES_URL` (+ `ANTHROPIC_API_KEY` for the narrated summary, `CRON_SECRET`, `chat:write`). (See `docs/superpowers/specs/2026-07-31-investor-weekly-report-design.md`.)
```

- [ ] **Step 2: Full verification**

Run: `npx tsc --noEmit && npm run lint && npm test && npm run investor -- --today 2026-08-04`
Expected: type-check/lint/tests clean; CLI prints the dry-run Ukrainian draft for week `2026-07-27_2026-08-02`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: npm run investor command reference

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
