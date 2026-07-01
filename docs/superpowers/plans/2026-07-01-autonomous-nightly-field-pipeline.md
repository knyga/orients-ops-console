# Autonomous Nightly Field Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single daily Vercel cron carries new flight days from raw Slack all the way to a posted #field-qa verdict with zero human steps, and sweeps up any settled-but-unpublished day across the month boundary.

**Architecture:** Lift the two currently-manual pipeline stages (field-qa extraction, verdict publish) out of their CLI `main()`s into shared `lib/` orchestration functions, then add one consolidated cron route `/api/cron/field-nightly` that runs `sync → extract → verdict → publish` sequentially, short-circuiting on error and DMing the operator on failure. A dry-run-by-default CLI (`npm run field-nightly`) exposes the same chain. The existing `sync` and `verdict` cron routes are folded in and removed.

**Tech Stack:** Next.js 16 App Router (route handlers), TypeScript strict, Vitest, Neon Postgres (DB-backed reports/published log via `lib/reports` + `lib/published`), Slack Web API via `lib/slack` (server-only).

## Global Constraints

- **Vercel Hobby plan** (team `knyga's projects`): functions cap at **60s** — the cron route sets `export const maxDuration = 60`; **max 2 cron jobs**; crons run **once/day** (best-effort timing). Design uses exactly **one** cron.
- **Vercel filesystem is read-only** except `/tmp`. The cron MUST NOT write repo files. The field-qa **inputs CSV** (`reports/field-ops/inputs/<period>.csv`) is a real `fs` write and stays **CLI-only**. All report/published persistence is DB-backed (`writeReport`, `writePublished`) and is safe in the cron.
- **Pure-lib boundary:** `lib/reconcile.ts`, `lib/flightHours.ts`, `lib/verdictPublish.ts`, `lib/fieldDayVerdict.ts` are pure and unit-tested — do NOT add server (`server-only`, `fs`, Slack, Vimeo, DB) imports to them.
- **server-only discipline:** modules that fetch live Slack/Vimeo import `"server-only"`; CLIs run under `node --conditions=react-server --import tsx` (already configured in `package.json`).
- **Two-interface rule (non-negotiable):** every feature ships a web/cron path AND a CLI path over the *same* shared `lib/` code. The cron and `npm run field-nightly` MUST call identical lib functions.
- **Outward Slack copy is Ukrainian** (verdict text is rebuilt in Ukrainian at post time by `formatDayMessage`; the operator failure DM is Ukrainian). Report JSON/CSV reasons stay English.
- **Idempotency:** publishing is idempotent via the `published` log (`isPublished`/`recordPublished`); PENDING days are never published (`publishableDays` excludes them).
- **Cron auth:** guard with `isAuthorizedCron(req)` (Bearer `CRON_SECRET`), same as the existing routes.
- Import alias `@/*` maps to repo root.

---

## File Structure

- **Create** `lib/nightlyWindow.ts` — pure `windowMonths(today, boundaryDays)`: the current month + (within the first N days of a month) the previous month. Unit-tested.
- **Create** `lib/fieldQaExtract.ts` — server-only `extractFieldQa(period, opts)`: the extraction loop lifted from `scripts/fieldQa.ts`, persisting the DB `field-qa` report. Returns `{ report, days, inputsCsv }`.
- **Create** `lib/publishVerdicts.ts` — server-only `publishSettledDays(days, channel, period, opts)`: the real-post loop lifted from `scripts/field-publish.ts`, idempotent via the published log. Returns `{ posted, skipped }`.
- **Create** `lib/nightlyNotice.ts` — pure `formatNightlyFailureNotice(stage, reason)` (Ukrainian operator DM text). Unit-tested.
- **Create** `lib/runNightly.ts` — server-only `runNightly(opts)`: the full `sync → extract → verdict → publish` orchestration over the window, short-circuit + anomaly detection, shared by the cron route and the CLI. Returns a structured summary.
- **Create** `app/api/cron/field-nightly/route.ts` — thin cron wrapper: auth → `runNightly({ publish: true })` → on thrown error DM operator + HTTP 500.
- **Create** `scripts/field-nightly.ts` — CLI: dry-run default (`runNightly({ publish: false })`), `--publish` posts for real.
- **Modify** `scripts/fieldQa.ts` — thin wrapper over `extractFieldQa` (adds the CLI-only inputs-CSV `fs` write).
- **Modify** `scripts/field-publish.ts` — real-post path delegates to `publishSettledDays`; dry-run rendering unchanged.
- **Modify** `vercel.json` — replace the two cron entries with the single `field-nightly` entry.
- **Delete** `app/api/cron/sync/route.ts`, `app/api/cron/verdict/route.ts`.
- **Modify** `package.json` — add the `field-nightly` script.
- **Modify** `CLAUDE.md` — document `npm run field-nightly` and the consolidated cron.

---

### Task 1: Pure catch-up window (`lib/nightlyWindow.ts`)

**Files:**
- Create: `lib/nightlyWindow.ts`
- Test: `lib/nightlyWindow.test.ts`

**Interfaces:**
- Consumes: nothing (pure date strings).
- Produces:
  - `interface WindowMonth { start: string; end: string }` (both `YYYY-MM-DD`)
  - `const CATCHUP_BOUNDARY_DAYS = 5`
  - `function windowMonths(today: string, boundaryDays?: number): WindowMonth[]` — returns the current month (`YYYY-MM-01` … `today`) always, and when `today`'s day-of-month ≤ `boundaryDays` ALSO the full previous month (`YYYY-MM-01` … last day of that month) FIRST in the array (older month processed first).

- [ ] **Step 1: Write the failing test**

```ts
// lib/nightlyWindow.test.ts
import { describe, it, expect } from "vitest";
import { windowMonths, CATCHUP_BOUNDARY_DAYS } from "./nightlyWindow";

describe("windowMonths", () => {
  it("mid-month returns only the current month up to today", () => {
    expect(windowMonths("2026-07-15")).toEqual([{ start: "2026-07-01", end: "2026-07-15" }]);
  });

  it("within the boundary also returns the full previous month, oldest first", () => {
    expect(windowMonths("2026-07-01")).toEqual([
      { start: "2026-06-01", end: "2026-06-30" },
      { start: "2026-07-01", end: "2026-07-01" },
    ]);
  });

  it("handles the January -> December year rollback", () => {
    expect(windowMonths("2026-01-03")).toEqual([
      { start: "2025-12-01", end: "2025-12-31" },
      { start: "2026-01-01", end: "2026-01-03" },
    ]);
  });

  it("respects the day exactly on the boundary and excludes the day after", () => {
    expect(windowMonths("2026-07-05")).toHaveLength(2);
    expect(windowMonths("2026-07-06")).toHaveLength(1);
  });

  it("exposes the default boundary constant", () => {
    expect(CATCHUP_BOUNDARY_DAYS).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/nightlyWindow.test.ts`
Expected: FAIL — `Cannot find module './nightlyWindow'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/nightlyWindow.ts
/**
 * Pure catch-up window for the nightly field pipeline. The nightly run always
 * covers the current Kyiv month; within the first few days of a new month it
 * ALSO covers the whole previous month, so settled-but-unpublished days from the
 * prior month are still swept up after the boundary rolls over (otherwise a
 * current-month-only run would strand them forever). No imports — unit-tested.
 */
export interface WindowMonth {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
}

/** Days into a new month during which the previous month stays in the window. */
export const CATCHUP_BOUNDARY_DAYS = 5;

/** Last calendar day (YYYY-MM-DD) of the month containing `ym` = "YYYY-MM". */
function lastDayOfMonth(year: number, month1to12: number): string {
  // Day 0 of the next month === last day of this month. Handles leap years.
  const d = new Date(Date.UTC(year, month1to12, 0));
  const mm = String(month1to12).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

export function windowMonths(today: string, boundaryDays: number = CATCHUP_BOUNDARY_DAYS): WindowMonth[] {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7)); // 1..12
  const day = Number(today.slice(8, 10));

  const current: WindowMonth = { start: `${today.slice(0, 7)}-01`, end: today };

  if (day > boundaryDays) return [current];

  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const pm = String(prevMonth).padStart(2, "0");
  const previous: WindowMonth = {
    start: `${prevYear}-${pm}-01`,
    end: lastDayOfMonth(prevYear, prevMonth),
  };
  return [previous, current];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/nightlyWindow.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/nightlyWindow.ts lib/nightlyWindow.test.ts
git commit -m "feat(field-nightly): pure catch-up window (current month + boundary previous month)"
```

---

### Task 2: Lift field-qa extraction into `lib/fieldQaExtract.ts`

Move the extraction loop out of `scripts/fieldQa.ts` `main()` into a shared server-only lib function that persists the DB report and returns the results. The CLI keeps the (fs-only) inputs-CSV write.

**Files:**
- Create: `lib/fieldQaExtract.ts`
- Modify: `scripts/fieldQa.ts` (thin wrapper)
- Test: `lib/fieldQaExtract.test.ts`

**Interfaces:**
- Consumes: `fetchMessages`, `downloadFileBase64` (`lib/slack`), `extractAirborne` (`lib/flightExtract`), `parseAirborneFromText` (`lib/flightTextParse`), `writeReport`/`periodKey` (`lib/reports`), and from `scripts/fieldQaReport`: `buildReport`, `validateDays`, `toInputsCsv`, types `ExtractedDay`, `Period`, `FieldQaReport`. (Note: `lib/computeVerdicts.ts` already imports pure shaping from `scripts/`, so lib→scripts imports follow the established pattern.)
- Produces:
  - `interface ExtractFieldQaResult { report: FieldQaReport; days: ExtractedDay[]; inputsCsv: string }`
  - `async function extractFieldQa(period: Period, opts?: { write?: boolean; onLog?: (m: string) => void }): Promise<ExtractFieldQaResult>` — fetches #field-qa summaries, extracts airborne time (text-first, Claude-vision fallback), validates, builds the report; with `write` persists the **DB** `field-qa` report (json + the inputs CSV as the csv sidecar). Never touches the repo filesystem.

- [ ] **Step 1: Write the failing test**

The extraction loop and Slack/Claude calls are integration-heavy; the unit test pins the two behaviours that the lift must preserve — (a) text-parsed days flow through to the report, (b) `write:false` calls `writeReport` zero times — by mocking the external modules.

```ts
// lib/fieldQaExtract.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMessages = vi.fn();
const writeReport = vi.fn(async () => ({ key: "2026-06" }));
vi.mock("./slack", () => ({ fetchMessages, downloadFileBase64: vi.fn() }));
vi.mock("./flightExtract", () => ({ extractAirborne: vi.fn() }));
vi.mock("./reports", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, writeReport };
});

import { extractFieldQa } from "./fieldQaExtract";

beforeEach(() => {
  fetchMessages.mockReset();
  writeReport.mockReset();
  writeReport.mockResolvedValue({ key: "2026-06" });
});

const summary = (date: string, minutes: number, ts: string) => ({
  channel: "field-qa",
  ts,
  permalink: `https://slack/${ts}`,
  files: [],
  text: `Статистика польотів за ${date}\nЧас в повітрі: ${minutes} хв`,
});

describe("extractFieldQa", () => {
  it("extracts text-parsed days into the report and does not write when write=false", async () => {
    fetchMessages.mockResolvedValue([summary("2026-06-29", 30, "100.1"), summary("2026-06-30", 18, "101.2")]);
    const { report, days } = await extractFieldQa(
      { start: "2026-06-01", end: "2026-06-30", timezone: "Europe/Kyiv" },
      { write: false },
    );
    expect(days.map((d) => d.date)).toEqual(["2026-06-29", "2026-06-30"]);
    expect(report.days).toHaveLength(2);
    expect(writeReport).not.toHaveBeenCalled();
  });

  it("persists the DB report when write=true", async () => {
    fetchMessages.mockResolvedValue([summary("2026-06-29", 30, "100.1")]);
    await extractFieldQa({ start: "2026-06-01", end: "2026-06-30", timezone: "Europe/Kyiv" }, { write: true });
    expect(writeReport).toHaveBeenCalledOnce();
    expect(writeReport.mock.calls[0][0]).toBe("field-qa");
  });
});
```

> Note: the exact `Час в повітрі` phrasing must match what `parseAirborneFromText` accepts. Before writing the impl, open `lib/flightTextParse.ts` and copy a real parseable line into the `summary()` helper if the above does not parse.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/fieldQaExtract.test.ts`
Expected: FAIL — `Cannot find module './fieldQaExtract'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/fieldQaExtract.ts
/**
 * Shared #field-qa airborne-time extraction. SERVER-ONLY (fetches live Slack and
 * may call Claude vision). One source of truth for turning the stats bot's daily
 * "Статистика польотів" cards into the committed field-qa report, called by BOTH
 * the `field-qa` CLI and the `/api/cron/field-nightly` route.
 *
 * With `write`, persists the DB field-qa report (reports/field-qa/<period>). It
 * NEVER writes the repo filesystem — the fieldops inputs CSV (a real fs artifact)
 * stays a CLI-only concern; callers use the returned `inputsCsv` for that.
 */
import "server-only";
import { downloadFileBase64, fetchMessages } from "./slack";
import { extractAirborne } from "./flightExtract";
import { parseAirborneFromText } from "./flightTextParse";
import { writeReport, periodKey } from "./reports";
import {
  buildReport,
  toInputsCsv,
  validateDays,
  type ExtractedDay,
  type FieldQaReport,
  type Period,
} from "../scripts/fieldQaReport";

const FIELD_QA_CHANNEL = "field-qa";
const SUMMARY_PREFIX = "Статистика польотів за ";
const TITLE_DATE = /Статистика польотів за (\d{4}-\d{2}-\d{2})/;

export interface ExtractFieldQaResult {
  report: FieldQaReport;
  days: ExtractedDay[];
  inputsCsv: string;
}

export interface ExtractFieldQaOptions {
  write?: boolean;
  onLog?: (message: string) => void;
}

export async function extractFieldQa(
  period: Period,
  opts: ExtractFieldQaOptions = {},
): Promise<ExtractFieldQaResult> {
  const log = opts.onLog ?? (() => {});

  const messages = await fetchMessages({ start: period.start, end: period.end });
  const summaries = messages.filter(
    (m) => m.channel === FIELD_QA_CHANNEL && m.text.startsWith(SUMMARY_PREFIX),
  );

  const extracted: ExtractedDay[] = [];
  for (const m of summaries) {
    const date = TITLE_DATE.exec(m.text)?.[1];
    if (!date) continue;
    let a = parseAirborneFromText(m.text);
    if (!a) {
      const image = m.files?.find((f) => f.mimetype.startsWith("image/"));
      if (!image) continue;
      const { base64, mediaType } = await downloadFileBase64(image.urlPrivate);
      a = await extractAirborne(base64, mediaType);
    }
    if (!a.flew || a.airborneSeconds <= 0) continue;
    extracted.push({ date, airborneSeconds: a.airborneSeconds, flights: a.flights, sourceTs: m.ts });
  }

  const days = validateDays(extracted);
  const permalinkByTs = new Map(summaries.map((m) => [m.ts, m.permalink]));
  const report = buildReport(days, period, permalinkByTs);
  const inputsCsv = toInputsCsv(days);

  if (opts.write) {
    const { key } = await writeReport("field-qa", period, {
      json: JSON.stringify(report, null, 2),
      csv: inputsCsv,
    });
    log(`field-qa: wrote field-qa/${key} (${report.totals.days} days, ${report.totals.flightHours} h)`);
  } else {
    // reference periodKey so an unused-import lint never trips if write path is edited out
    void periodKey;
  }

  return { report, days, inputsCsv };
}
```

> Remove the `void periodKey;` line and the `periodKey` import if not otherwise needed — it is only there to avoid churn; prefer no unused import.

- [ ] **Step 4: Refactor `scripts/fieldQa.ts` to a thin wrapper**

Replace the body of `main()` (keep the arg-parsing, period resolution, and the CLI-only inputs-CSV fs write). The new `main()`:

```ts
// scripts/fieldQa.ts — main() body (imports: add extractFieldQa from "../lib/fieldQaExtract";
// keep mkdirSync/writeFileSync/dirname/join, parseArgs/resolvePeriod/formatTable, defaultBaseDir/periodKey.
// REMOVE now-unused imports: fetchMessages, downloadFileBase64, extractAirborne, parseAirborneFromText,
// buildReport, validateDays, toInputsCsv, ExtractedDay, writeReport, FIELD_QA_CHANNEL/SUMMARY_PREFIX/TITLE_DATE consts.)
async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* rely on ambient env */ }

  const args = parseArgs(process.argv.slice(2));
  const period = resolvePeriod(args, todayInFieldTz());

  const { report, inputsCsv } = await extractFieldQa(period, {
    write: args.write,
    onLog: (m) => process.stderr.write(`${m}\n`),
  });

  if (args.format === "table") console.log(formatTable(report));
  else console.log(JSON.stringify(report, null, 2));

  if (args.write) {
    // CLI-only: mirror the DB report's CSV to the fieldops inputs path (a real fs artifact).
    const inputs = inputsPath(period);
    mkdirSync(dirname(inputs), { recursive: true });
    writeFileSync(inputs, inputsCsv);
    process.stderr.write(`field-qa: wrote ${inputs}\n`);
  }
}
```

- [ ] **Step 5: Run the extraction test + existing field-qa tests**

Run: `npx vitest run lib/fieldQaExtract.test.ts scripts/fieldQaReport.test.ts`
Expected: PASS (new + any existing shaping tests unchanged).

- [ ] **Step 6: Smoke-test the CLI still works (dry, no write)**

Run: `npm run field-qa -- --start 2026-06-01 --end 2026-06-30 --format table 2>&1 | tail -5`
Expected: the same table it printed before the refactor (a TOTAL line with days/hours). No errors.

- [ ] **Step 7: Commit**

```bash
git add lib/fieldQaExtract.ts lib/fieldQaExtract.test.ts scripts/fieldQa.ts
git commit -m "refactor(field-qa): lift extraction into lib/fieldQaExtract (shared by cron); CLI keeps fs inputs-csv"
```

---

### Task 3: Lift verdict publishing into `lib/publishVerdicts.ts`

Move the real-post loop out of `scripts/field-publish.ts` `main()` into a shared server-only lib function. Keep `lib/verdictPublish.ts` PURE (formatting only) — this new module is the server orchestration, mirroring `computeVerdicts.ts`.

**Files:**
- Create: `lib/publishVerdicts.ts`
- Modify: `scripts/field-publish.ts` (real path delegates; dry-run unchanged)
- Test: `lib/publishVerdicts.test.ts`

**Interfaces:**
- Consumes: `postMessage` (`lib/slack`), `verdictKey` (`lib/outboundKeys`), `readPublished`/`recordPublished`/`writePublished`/`isPublished` (`lib/published`), `periodKey` (`lib/reports`), `publishableDays` (`lib/verdictPublish`), `SlackChannel` (`lib/slackChannels`), `DayVerdict` (`lib/fieldDayVerdict`), `formatDayMessage` (`lib/verdictPublish`), `Period` (`scripts/fieldPublishReport`).
- Produces:
  - `interface PublishResult { posted: string[]; skipped: string[] }` (arrays of dates)
  - `async function publishSettledDays(days: DayVerdict[], channel: SlackChannel, period: Period, opts?: { onLog?: (m: string) => void }): Promise<PublishResult>` — for each publishable (settled) day not already in the published log, posts `formatDayMessage(day)` to `channel`, records + persists the published log after each post. Returns posted vs skipped (already-published) dates.

- [ ] **Step 1: Write the failing test**

```ts
// lib/publishVerdicts.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const postMessage = vi.fn(async () => "1782900000.000100");
const readPublished = vi.fn();
const writePublished = vi.fn(async () => {});
vi.mock("./slack", () => ({ postMessage }));
vi.mock("./published", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, readPublished, writePublished };
});

import { publishSettledDays } from "./publishVerdicts";
import type { DayVerdict } from "./fieldDayVerdict";

const channel = { id: "C08GY2NKF9D", name: "field-qa" };
const period = { start: "2026-06-01", end: "2026-06-30" };

// Minimal settled ACCEPTED day. Fill any additional required DayVerdict fields
// from lib/fieldDayVerdict.ts when writing the impl (keep the object type-valid).
const day = (date: string): DayVerdict => ({
  date, status: "ACCEPTED", airborneMinutes: 20, videoMinutes: 40, ratio: 2,
  datasetStatus: "POSTED", reasons: [], roster: [], unknownInitials: [],
  airborneReported: true, deployWindow: null,
} as DayVerdict);

beforeEach(() => {
  postMessage.mockReset().mockResolvedValue("1782900000.000100");
  readPublished.mockReset();
  writePublished.mockReset().mockResolvedValue(undefined);
});

describe("publishSettledDays", () => {
  it("posts each unpublished settled day and records it", async () => {
    readPublished.mockResolvedValue({ period: "2026-06", days: {} });
    const res = await publishSettledDays([day("2026-06-29"), day("2026-06-30")], channel, period);
    expect(res.posted).toEqual(["2026-06-29", "2026-06-30"]);
    expect(res.skipped).toEqual([]);
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(writePublished).toHaveBeenCalledTimes(2); // persisted after each post
  });

  it("skips days already in the published log (idempotent)", async () => {
    readPublished.mockResolvedValue({ period: "2026-06", days: { "2026-06-29": { ts: "x" } } });
    const res = await publishSettledDays([day("2026-06-29"), day("2026-06-30")], channel, period);
    expect(res.posted).toEqual(["2026-06-30"]);
    expect(res.skipped).toEqual(["2026-06-29"]);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});
```

> Before writing the impl, open `lib/published.ts` to confirm the `PublishedLog` shape and `isPublished(log, date)` / `recordPublished(log, entry)` signatures, and `lib/fieldDayVerdict.ts` for the exact `DayVerdict` fields, then adjust the `day()` fixture and the mocked log shape to match.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/publishVerdicts.test.ts`
Expected: FAIL — `Cannot find module './publishVerdicts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/publishVerdicts.ts
/**
 * Shared verdict-publishing orchestration. SERVER-ONLY (posts to Slack + writes
 * the DB published log). One source of truth for the real-post loop, called by
 * BOTH the `field-publish` CLI (real path) and the `/api/cron/field-nightly`
 * route. Pure formatting/selection stays in lib/verdictPublish; this is the
 * effectful driver, mirroring lib/computeVerdicts.
 *
 * Posts only SETTLED days (publishableDays: ACCEPTED / NEEDS_REVIEW /
 * ACCEPTED_EXCEPTION — never PENDING) that are not already in the published log.
 * Idempotent: the published log is persisted after EACH post so a mid-run failure
 * never re-posts an already-sent day.
 */
import "server-only";
import { postMessage } from "./slack";
import { verdictKey } from "./outboundKeys";
import { periodKey } from "./reports";
import { isPublished, readPublished, recordPublished, writePublished } from "./published";
import { formatDayMessage, publishableDays } from "./verdictPublish";
import type { SlackChannel } from "./slackChannels";
import type { DayVerdict } from "./fieldDayVerdict";
import type { Period } from "../scripts/fieldPublishReport";

export interface PublishResult {
  posted: string[];
  skipped: string[];
}

export async function publishSettledDays(
  days: DayVerdict[],
  channel: SlackChannel,
  period: Period,
  opts: { onLog?: (m: string) => void } = {},
): Promise<PublishResult> {
  const log = opts.onLog ?? (() => {});
  const key = periodKey(period);
  let publishedLog = await readPublished(period);

  const posted: string[] = [];
  const skipped: string[] = [];
  for (const day of publishableDays(days)) {
    if (isPublished(publishedLog, day.date)) {
      skipped.push(day.date);
      continue;
    }
    const text = formatDayMessage(day);
    const ts = await postMessage(channel.id, text, {
      key: verdictKey(key, day.date),
      feature: "verdict",
      channel: channel.name,
      trigger: "cron",
    });
    publishedLog = recordPublished(publishedLog, {
      date: day.date,
      channel: channel.name,
      text,
      postedAt: new Date().toISOString(),
      ts,
    });
    await writePublished(period, publishedLog); // persist after each post
    posted.push(day.date);
    log(`field-publish: posted ${day.date} to #${channel.name} (ts ${ts})`);
  }
  return { posted, skipped };
}
```

> `trigger: "cron"` is valid (`SendTrigger = "cli" | "cron" | "webhook" | "unknown"`). The CLI real path (Step 4) overrides this by passing its own trigger if it wants `"cli"` — see note there.

- [ ] **Step 4: Refactor `scripts/field-publish.ts` real path to delegate**

Keep arg parse, period resolve, report read, and the dry-run branch (`formatDryRun`) exactly as-is. Replace ONLY the real-publish block (current lines ~74–112) with a delegation to `publishSettledDays`, preserving the channel validation and the "nothing to post" message:

```ts
// scripts/field-publish.ts — replace the "--- Real publish path ---" block:
  // --- Real publish path (explicit --publish) ---
  if (!args.channel) {
    process.stderr.write("field-publish: --publish requires --channel <name> (no default target).\n");
    process.exit(1);
  }
  const channel = TRACKED_CHANNELS.find((c) => c.name === args.channel);
  if (!channel) {
    process.stderr.write(
      `field-publish: unknown channel "${args.channel}" (tracked: ${TRACKED_CHANNELS.map((c) => c.name).join(", ")}).\n`,
    );
    process.exit(1);
  }

  const { posted, skipped } = await publishSettledDays(report.days, channel, period, {
    onLog: (m) => process.stderr.write(`${m}\n`),
  });
  if (posted.length === 0) {
    process.stderr.write("field-publish: nothing new to post (all publishable days already published).\n");
    return;
  }
  process.stderr.write(`field-publish: posted ${posted.length} verdict(s) to #${channel.name} (skipped ${skipped.length}).\n`);
```

Update imports: add `import { publishSettledDays } from "../lib/publishVerdicts";`. Remove now-unused imports (`postMessage`, `verdictKey`, `readPublished`, `recordPublished`, `writePublished`) IF no longer referenced (the dry-run path still uses `readPublished` and `buildPlan`/`pendingItems`/`formatDryRun` — keep `readPublished`). Verify by letting the type-check catch unused vars.

> The audit-log `trigger` for CLI real posts becomes `"cron"` via the shared function. If preserving `"cli"` matters for the audit trail, add an optional `trigger?: SendTrigger` to `publishSettledDays` opts (default `"cron"`) and pass `"cli"` from the CLI. Do this only if a `sent`-log test asserts the trigger.

- [ ] **Step 5: Run tests**

Run: `npx vitest run lib/publishVerdicts.test.ts scripts/fieldPublishReport.test.ts lib/verdictPublish.test.ts`
Expected: PASS (new + existing pure tests unchanged — `lib/verdictPublish.ts` was not modified).

- [ ] **Step 6: Smoke-test the CLI dry-run is unchanged**

Run: `npm run field-publish -- --start 2026-06-01 --end 2026-06-30 --channel field-qa 2>&1 | tail -6`
Expected: `DRY RUN — would post 0 verdict(s)` (all June days already published as of this plan), no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/publishVerdicts.ts lib/publishVerdicts.test.ts scripts/field-publish.ts
git commit -m "refactor(field-publish): lift real-post loop into lib/publishVerdicts (shared by cron)"
```

---

### Task 4: Operator failure notice (`lib/nightlyNotice.ts`)

**Files:**
- Create: `lib/nightlyNotice.ts`
- Test: `lib/nightlyNotice.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `function formatNightlyFailureNotice(stage: string, reason: string): string` — a terse Ukrainian DM the cron sends to the operator when a stage fails or an anomaly is detected. Truncates the reason (reuse the 240-char discipline from `webhookNotice`).

- [ ] **Step 1: Write the failing test**

```ts
// lib/nightlyNotice.test.ts
import { describe, it, expect } from "vitest";
import { formatNightlyFailureNotice } from "./nightlyNotice";

describe("formatNightlyFailureNotice", () => {
  it("names the stage and includes the reason", () => {
    const msg = formatNightlyFailureNotice("extract", "Vimeo 502");
    expect(msg).toContain("extract");
    expect(msg).toContain("Vimeo 502");
    expect(msg.startsWith("⚠️")).toBe(true);
  });

  it("truncates a very long reason", () => {
    const msg = formatNightlyFailureNotice("publish", "x".repeat(1000));
    expect(msg.length).toBeLessThan(360);
  });

  it("falls back when the reason is blank", () => {
    expect(formatNightlyFailureNotice("verdict", "   ")).toContain("невідома помилка");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/nightlyNotice.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/nightlyNotice.ts
/**
 * Pure formatting for the nightly field pipeline's operator failure DM. When a
 * stage of /api/cron/field-nightly throws (or an anomaly is detected) the cron
 * DMs the operator so a hands-off failure is not silent. Ukrainian, terse. No
 * imports — unit-tested.
 */
const MAX_REASON = 240;

export function formatNightlyFailureNotice(stage: string, reason: string): string {
  const trimmed = reason.trim().slice(0, MAX_REASON) || "невідома помилка";
  return `⚠️ Нічний польотний конвеєр збійнув на етапі «${stage}»: ${trimmed}. Публікацію зупинено; перевірте логи Vercel.`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/nightlyNotice.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/nightlyNotice.ts lib/nightlyNotice.test.ts
git commit -m "feat(field-nightly): pure operator failure-notice formatter"
```

---

### Task 5: Nightly orchestration (`lib/runNightly.ts`)

The shared driver both the cron and CLI call. Runs `sync → (per window month: extract → verdict) → (per window month: publish)`. Short-circuits: any thrown stage aborts before publishing. Detects the "extract found new flight days but published 0" anomaly. On failure/anomaly, DMs the operator (best-effort) — but only when actually posting (`publish: true`); dry-run never DMs or posts.

**Files:**
- Create: `lib/runNightly.ts`
- Test: `lib/runNightly.test.ts`

**Interfaces:**
- Consumes: `syncAllChannels`, `todayInFieldTz` (`lib/syncChannels`), `windowMonths` (`lib/nightlyWindow`), `extractFieldQa` (`lib/fieldQaExtract`), `computeVerdicts` (`lib/computeVerdicts`), `publishSettledDays` (`lib/publishVerdicts`), `TRACKED_CHANNELS` (`lib/slackChannels`), `APPROVERS` (`lib/approvers`), `openDm`, `postMessage` (`lib/slack`), `formatNightlyFailureNotice` (`lib/nightlyNotice`).
- Produces:
  - `interface NightlyMonthResult { period: { start: string; end: string }; extractedDays: number; posted: string[]; skipped: string[] }`
  - `interface NightlySummary { publish: boolean; months: NightlyMonthResult[] }`
  - `async function runNightly(opts: { publish: boolean; today?: string; onLog?: (m: string) => void }): Promise<NightlySummary>` — throws on any stage failure AFTER attempting an operator DM (when `publish`).

- [ ] **Step 1: Write the failing test**

```ts
// lib/runNightly.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const syncAllChannels = vi.fn(async () => ({ summaries: [], failures: 0 }));
const extractFieldQa = vi.fn();
const computeVerdicts = vi.fn();
const publishSettledDays = vi.fn(async () => ({ posted: [], skipped: [] }));
const openDm = vi.fn(async () => "D0OPERATOR");
const postMessage = vi.fn(async () => "1.1");

vi.mock("./syncChannels", () => ({ syncAllChannels, todayInFieldTz: () => "2026-07-15" }));
vi.mock("./fieldQaExtract", () => ({ extractFieldQa }));
vi.mock("./computeVerdicts", () => ({ computeVerdicts }));
vi.mock("./publishVerdicts", () => ({ publishSettledDays }));
vi.mock("./slack", () => ({ openDm, postMessage }));

import { runNightly } from "./runNightly";

beforeEach(() => {
  for (const m of [syncAllChannels, extractFieldQa, computeVerdicts, publishSettledDays, openDm, postMessage]) m.mockReset();
  syncAllChannels.mockResolvedValue({ summaries: [], failures: 0 });
  extractFieldQa.mockResolvedValue({ days: [{ date: "2026-07-14" }], report: {} });
  computeVerdicts.mockResolvedValue({ days: [{ date: "2026-07-14", status: "ACCEPTED" }], summary: {} });
  publishSettledDays.mockResolvedValue({ posted: ["2026-07-14"], skipped: [] });
  openDm.mockResolvedValue("D0OPERATOR");
  postMessage.mockResolvedValue("1.1");
});

describe("runNightly", () => {
  it("mid-month: syncs once, processes the current month, publishes when publish=true", async () => {
    const res = await runNightly({ publish: true, today: "2026-07-15" });
    expect(syncAllChannels).toHaveBeenCalledOnce();
    expect(res.months).toHaveLength(1);
    expect(res.months[0].posted).toEqual(["2026-07-14"]);
    expect(publishSettledDays).toHaveBeenCalledOnce();
    expect(postMessage).not.toHaveBeenCalled(); // no failure DM on success
  });

  it("dry-run: never publishes and never DMs", async () => {
    await runNightly({ publish: false, today: "2026-07-15" });
    expect(publishSettledDays).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("boundary: processes previous + current month (2 iterations)", async () => {
    await runNightly({ publish: true, today: "2026-07-02" });
    expect(extractFieldQa).toHaveBeenCalledTimes(2);
    expect(computeVerdicts).toHaveBeenCalledTimes(2);
  });

  it("short-circuits on extract failure: DMs the operator, does not publish, rethrows", async () => {
    extractFieldQa.mockRejectedValueOnce(new Error("boom"));
    await expect(runNightly({ publish: true, today: "2026-07-15" })).rejects.toThrow("boom");
    expect(publishSettledDays).not.toHaveBeenCalled();
    expect(openDm).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledOnce(); // the failure DM
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/runNightly.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/runNightly.ts
/**
 * Shared orchestration for the autonomous nightly field pipeline. SERVER-ONLY.
 * Runs sync → (per window month: extract → verdict) → (per window month:
 * publish), called by BOTH /api/cron/field-nightly (publish:true) and the
 * `field-nightly` CLI (dry-run default). Sequential + in-process: any stage
 * failure short-circuits BEFORE publishing, so the bot never posts on stale or
 * partial data. On failure (or an "extracted new days but posted nothing"
 * anomaly) it DMs the operator best-effort, then rethrows so the caller can
 * return HTTP 500. Dry-run neither posts nor DMs.
 */
import "server-only";
import { syncAllChannels, todayInFieldTz } from "./syncChannels";
import { FIELD_TIMEZONE } from "./reconcile";
import { windowMonths } from "./nightlyWindow";
import { extractFieldQa } from "./fieldQaExtract";
import { computeVerdicts } from "./computeVerdicts";
import { publishSettledDays } from "./publishVerdicts";
import { TRACKED_CHANNELS } from "./slackChannels";
import { APPROVERS } from "./approvers";
import { openDm, postMessage } from "./slack";
import { formatNightlyFailureNotice } from "./nightlyNotice";

const FIELD_QA = "field-qa";

export interface NightlyMonthResult {
  period: { start: string; end: string };
  extractedDays: number;
  posted: string[];
  skipped: string[];
}

export interface NightlySummary {
  publish: boolean;
  months: NightlyMonthResult[];
}

export interface RunNightlyOptions {
  publish: boolean;
  today?: string;
  onLog?: (message: string) => void;
}

/** Best-effort operator DM; a failed DM must not mask the original error. */
async function notifyOperator(stage: string, reason: string, log: (m: string) => void): Promise<void> {
  try {
    const dm = await openDm(APPROVERS[0].userId);
    await postMessage(dm, formatNightlyFailureNotice(stage, reason), {
      key: `field-nightly-failure:${stage}:${reason.slice(0, 40)}`,
      feature: "nightly-failure",
      channel: "dm",
      trigger: "cron",
    });
  } catch (e) {
    log(`field-nightly: operator DM failed — ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function runNightly(opts: RunNightlyOptions): Promise<NightlySummary> {
  const log = opts.onLog ?? (() => {});
  const today = opts.today ?? todayInFieldTz();
  const channel = TRACKED_CHANNELS.find((c) => c.name === FIELD_QA);
  if (!channel) throw new Error(`field-nightly: no tracked channel "${FIELD_QA}"`);

  let stage = "sync";
  try {
    // 1. Sync once for the whole run.
    await syncAllChannels({ mode: "incremental", window: 7, onLog: log });

    // 2. Per window month: extract → verdict (compute even in dry-run; it does not post).
    // extractFieldQa's buildReport needs a timezone on the period; computeVerdicts
    // and publishSettledDays only read start/end, so a timezone-carrying period is
    // safe for all three.
    stage = "extract/verdict";
    const window = windowMonths(today);
    const computed = [];
    for (const wm of window) {
      const period = { start: wm.start, end: wm.end, timezone: FIELD_TIMEZONE };
      const ex = await extractFieldQa(period, { write: true, onLog: log });
      const report = await computeVerdicts(period, { today, write: true, onLog: log });
      computed.push({ period, extractedDays: ex.days.length, report });
    }

    // 3. Per window month: publish settled days (only when publishing for real).
    stage = "publish";
    const months: NightlyMonthResult[] = [];
    for (const c of computed) {
      let posted: string[] = [];
      let skipped: string[] = [];
      if (opts.publish) {
        ({ posted, skipped } = await publishSettledDays(c.report.days, channel, c.period, { onLog: log }));
        // Anomaly: extracted new flight days for this month but nothing settled posted or was already posted.
        if (c.extractedDays > 0 && posted.length === 0 && skipped.length === 0) {
          await notifyOperator(
            "publish",
            `extracted ${c.extractedDays} day(s) for ${c.period.start}..${c.period.end} but published 0 settled verdicts`,
            log,
          );
        }
      } else {
        log(`field-nightly (dry-run): would publish settled days for ${c.period.start}..${c.period.end}`);
      }
      months.push({ period: c.period, extractedDays: c.extractedDays, posted, skipped });
    }

    return { publish: opts.publish, months };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (opts.publish) await notifyOperator(stage, reason, log);
    throw error;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/runNightly.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/runNightly.ts lib/runNightly.test.ts
git commit -m "feat(field-nightly): shared sync->extract->verdict->publish orchestration (short-circuit + operator DM)"
```

---

### Task 6: Cron route, CLI, config, docs

Wire the orchestration to the single Vercel cron and the CLI; fold in and delete the old routes; update `vercel.json`, `package.json`, `CLAUDE.md`.

**Files:**
- Create: `app/api/cron/field-nightly/route.ts`
- Create: `scripts/field-nightly.ts`
- Delete: `app/api/cron/sync/route.ts`, `app/api/cron/verdict/route.ts`
- Modify: `vercel.json`, `package.json`, `CLAUDE.md`

**Interfaces:**
- Consumes: `isAuthorizedCron` (`lib/cronAuth`), `runNightly` (`lib/runNightly`).
- Produces: `GET /api/cron/field-nightly` (JSON summary, or 401/500); `npm run field-nightly` CLI.

- [ ] **Step 1: Write the cron route**

```ts
// app/api/cron/field-nightly/route.ts
/**
 * Vercel Cron: the autonomous nightly field pipeline. Runs
 * sync → field-qa extract → verdict compute → publish settled days to #field-qa,
 * over the catch-up window (current Kyiv month + the previous month for the first
 * few days after a month rolls over). Guarded by CRON_SECRET. Scheduled in
 * vercel.json. On any stage failure it DMs the operator (in runNightly) and
 * returns 500 so Vercel's cron-failure alerting fires too.
 *
 * Hobby-plan constraint: must finish within 60s (see maxDuration). This is the
 * single cron the console uses.
 */
import { isAuthorizedCron } from "@/lib/cronAuth";
import { runNightly } from "@/lib/runNightly";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  if (!isAuthorizedCron(req)) return new Response("unauthorized", { status: 401 });
  try {
    const summary = await runNightly({ publish: true });
    return Response.json({ ok: true, summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
```

- [ ] **Step 2: Write the CLI**

```ts
// scripts/field-nightly.ts
/**
 * CLI: run the full autonomous field pipeline (sync → extract → verdict →
 * publish) locally — DRY-RUN BY DEFAULT. Mirrors /api/cron/field-nightly via the
 * shared lib/runNightly, so CLI and cron cannot diverge.
 *
 *   npm run field-nightly                      # dry-run over the catch-up window
 *   npm run field-nightly -- --today 2026-07-02  # dry-run pinned to a date
 *   npm run field-nightly -- --publish         # ACTUALLY sync/extract/verdict/publish to #field-qa
 *
 * Runs under `--conditions=react-server` so the server-only imports resolve.
 */
import { runNightly } from "../lib/runNightly";

function parseArgs(argv: string[]): { publish: boolean; today?: string } {
  const out: { publish: boolean; today?: string } = { publish: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--publish") out.publish = true;
    else if (argv[i] === "--today") { out.today = argv[i + 1]; i += 1; }
  }
  return out;
}

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* rely on ambient env */ }
  const args = parseArgs(process.argv.slice(2));
  const summary = await runNightly({
    publish: args.publish,
    today: args.today,
    onLog: (m) => process.stderr.write(`${m}\n`),
  });
  console.log(JSON.stringify(summary, null, 2));
  if (!args.publish) {
    process.stderr.write("field-nightly: DRY RUN — nothing was published. Re-run with --publish to post to #field-qa.\n");
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`field-nightly: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
```

- [ ] **Step 3: Delete the folded-in routes and update `vercel.json`**

```bash
git rm app/api/cron/sync/route.ts app/api/cron/verdict/route.ts
```

Replace `vercel.json` crons array:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "crons": [
    { "path": "/api/cron/field-nightly", "schedule": "30 6 * * *" }
  ]
}
```

- [ ] **Step 4: Add the `package.json` script**

Add under `scripts` (next to the other `field-*`):

```json
"field-nightly": "node --conditions=react-server --import tsx scripts/field-nightly.ts",
```

- [ ] **Step 5: Verify the build + full test suite pass**

Run: `npm run lint && npx vitest run && npm run build`
Expected: lint clean, all tests pass, build succeeds (no leftover imports to the deleted routes; `maxDuration`/route typecheck OK).

- [ ] **Step 6: Manual verification — CLI dry-run (no posts)**

Run: `npm run field-nightly -- --today 2026-07-15 2>&1 | tail -20`
Expected: JSON summary with `"publish": false`, one month entry (`2026-07`), and the `DRY RUN — nothing was published` notice. Confirm nothing was posted to Slack (`npm run sent -- --start 2026-07-01 --end 2026-07-31 --format table` shows no new nightly rows).

- [ ] **Step 7: Update `CLAUDE.md`**

In the Commands list, add (near the other `field-*` entries):

```md
- `npm run field-nightly -- [--publish] [--today YYYY-MM-DD]` — run the whole autonomous field pipeline locally: incremental Slack sync → #field-qa airborne extraction → verdict compute → publish settled verdicts to #field-qa, over the catch-up window (current Kyiv month + the previous month for the first ~5 days of a new month). **DRY-RUN by default** (computes + writes reports but posts nothing); `--publish` posts for real to #field-qa. This is the CLI mirror of the `/api/cron/field-nightly` Vercel cron (the single daily cron). Short-circuits on any stage failure and DMs the operator. (See `docs/superpowers/specs/2026-07-01-autonomous-nightly-field-pipeline-design.md`.)
```

In the Architecture / cron notes, replace any mention of the separate `sync`/`verdict` crons with: "A single Vercel cron `/api/cron/field-nightly` (06:30 UTC / 09:30 Kyiv) runs the full field pipeline; `lib/runNightly.ts` is the shared orchestration behind it and `npm run field-nightly`."

- [ ] **Step 8: Commit**

```bash
git add app/api/cron/field-nightly/route.ts scripts/field-nightly.ts vercel.json package.json CLAUDE.md
git commit -m "feat(field-nightly): consolidated Vercel cron + CLI; fold in & remove sync/verdict crons"
```

---

## Post-implementation (deploy-time, not code)

- **Env on Vercel:** confirm `CRON_SECRET`, `ANTHROPIC_API_KEY`, `VIMEO_TOKEN`, `SLACK_TOKEN` (+ `im:write` scope for the operator DM, `chat:write` for posting), and `POSTGRES_URL`/`DATABASE_URL` are set for Production. The extraction (Claude) + operator DM (im:write) are NEW server-side dependencies for the cron path.
- **First-run watch:** after deploy, watch the first `/api/cron/field-nightly` run in Vercel logs; confirm it posts only genuinely-new settled days (the June backlog was already cleared manually on 2026-07-01, so it must NOT re-post those).
- **60s budget:** if the boundary run (2 months × extract+verdict) approaches 60s in practice, split into the two-cron fallback from the spec (`field-nightly-compute` + `field-nightly-publish`).

## Self-Review

**Spec coverage:**
- §1 consolidated cron → Task 5 (`runNightly`) + Task 6 (route, `maxDuration=60`, single `vercel.json` entry, delete old routes). ✓
- §2 lift orchestration → Task 2 (`extractFieldQa`) + Task 3 (`publishSettledDays`); `syncAllChannels`/`computeVerdicts` reused as-is. ✓ (Deviation from spec, improved: publish orchestration lives in new `lib/publishVerdicts.ts` not `lib/verdictPublish.ts`, to preserve the pure-lib boundary — noted in File Structure.)
- §3 catch-up window → Task 1 (`windowMonths`) + Task 5 loop. ✓
- §4 failure visibility → Task 4 (`formatNightlyFailureNotice`) + Task 5 (`notifyOperator`, rethrow) + Task 6 (route 500). ✓
- §5 CLI second interface → Task 6 (`scripts/field-nightly.ts`, dry-run default) + package.json + CLAUDE.md. ✓
- §6 backlog → already cleared manually 2026-07-01; Post-implementation note guards against re-post. ✓
- Testing section (spec) → unit tests in Tasks 1–5; manual verification in Task 6. ✓

**Placeholder scan:** No TBD/TODO. Two explicit "before writing the impl, open X and confirm the shape" notes (Tasks 2 & 3) are verification instructions against real files, not placeholders — the fixtures are complete and runnable, the notes just guard against a field-name drift the plan author could not see without the file open.

**Type consistency:** `extractFieldQa` returns `{ report, days, inputsCsv }` (Task 2) — consumed in Task 5 as `ex.days.length` and Task 6 CLI via `runNightly`. `publishSettledDays(days, channel, period, opts)` → `{ posted, skipped }` (Task 3) — consumed identically in Task 5 and `scripts/field-publish.ts`. `windowMonths(today)` → `WindowMonth[]` with `{start,end}` (Task 1) — consumed as `period` in Task 5, matching `computeVerdicts`/`extractFieldQa`'s `Period` (both use `{start,end}`; `extractFieldQa`'s `Period` also carries `timezone` — Task 5 passes `WindowMonth` which lacks `timezone`; **resolve during Task 5 by widening `extractFieldQa` to accept `{start,end}` or by adding `timezone: FIELD_TIMEZONE` when building the window period**). `formatNightlyFailureNotice(stage, reason)` (Task 4) — called in Task 5 `notifyOperator`. `runNightly({publish, today?, onLog?})` → `NightlySummary` (Task 5) — called in Task 6 route and CLI. Consistent.

> **Type note (resolved in Task 5 code above):** `scripts/fieldQaReport.Period` is `{start,end,timezone}` (its `buildReport` writes `FieldQaReport.period.timezone`), while `windowMonths` yields `{start,end}` and `computeVerdicts`/`publishSettledDays` read only `start`/`end`. Resolution: `runNightly` builds one `{ start, end, timezone: FIELD_TIMEZONE }` per window month and passes it to all three — `extractFieldQa` keeps its `fieldQaReport.Period` param unchanged; the extra `timezone` is harmless for the other two.
