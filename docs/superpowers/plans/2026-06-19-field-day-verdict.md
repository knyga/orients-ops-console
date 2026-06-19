# Field-day acceptance verdict + resolutions store (S3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compute a per-flight-day bonus-acceptance verdict (ACCEPTED / PENDING / NEEDS_REVIEW / ACCEPTED_EXCEPTION) from airborne minutes (S2), Vimeo video attributed by the date in the video name, a #datasets notice, and a committed resolutions store — surfaced via a CLI committed artifact and the web.

**Architecture:** New pure, unit-tested libs (`lib/workdays.ts` shared working-day math; `videoFlightDate` in `lib/reconcile.ts`; `lib/datasetNotice.ts`; `lib/fieldDayVerdict.ts`; `lib/resolutions.ts` committed store) consumed by a new `scripts/field-verdict.ts` CLI (airborne from the committed field-qa report, video live from Vimeo, dataset notices from the S1 Slack mirror, resolutions from the store) that writes `reports/field-verdict/<period>.{json,csv}`, plus a hybrid `GET /api/field-verdict` and a web tab.

**Tech Stack:** TypeScript strict, Vitest, Next 16 App Router, the existing Vimeo/Slack-mirror/reports infra. Mirrors house conventions in `CLAUDE.md` and `.claude/skills/authoring-reporting-features/`.

**Spec:** `docs/superpowers/specs/2026-06-19-field-day-acceptance-and-publishing-design.md` (phase B). Attribution rule resolved: by date in video name (see memory `video-name-carries-flight-date`).

---

## File structure

| File | Responsibility | Tested |
|---|---|---|
| `lib/workdays.ts` (create) | `isWorkingDay`, `addWorkingDays` (extracted from `policySchedule.ts`, single copy). | ✅ |
| `lib/policySchedule.ts` (modify) | Re-export/import the two helpers from `lib/workdays.ts` (no behavior change). | existing tests |
| `lib/reconcile.ts` (modify) | Add pure `videoFlightDate(name, createdTime)` (parse date from name, fallback Kyiv upload date). | ✅ |
| `lib/datasetNotice.ts` (create) | `hasDatasetNotice(messages, date, windowEnd)` — detect a #datasets notice referencing a flight date. | ✅ |
| `lib/fieldDayVerdict.ts` (create) | Pure `verdictForDay(...)` → `{status, ratio, reasons[]}`; `applyResolution`. | ✅ |
| `lib/resolutions.ts` (create) | Committed resolutions store: types, read/write, pure `resolutionFor`. | ✅ |
| `scripts/fieldVerdictReport.ts` (create) | Pure CLI shaping: `parseArgs`, `resolvePeriod`, `buildReport`, `formatTable`, `toCsv`. | ✅ |
| `scripts/field-verdict.ts` (create) | CLI: gather inputs, compute verdicts, print, `--write` artifact. | manual |
| `app/api/field-verdict/route.ts` (create) | Hybrid route: `?periods=1` / `?period=<key>` (committed). | — |
| `app/(dashboard)/field-verdict/page.tsx` (create) | Web tab rendering committed verdicts. | — |
| `app/(dashboard)/layout.tsx` (modify) | Add the nav entry. | — |
| `package.json` (modify) | Add `"field-verdict"` script. | — |

**Canonical types (Task 4/5 — referenced across tasks):**

```ts
// lib/fieldDayVerdict.ts
export type VerdictStatus = "ACCEPTED" | "PENDING" | "NEEDS_REVIEW" | "ACCEPTED_EXCEPTION";

export interface DayVerdict {
  date: string;            // YYYY-MM-DD flight day
  status: VerdictStatus;
  airborneMinutes: number;
  videoMinutes: number;
  ratio: number | null;    // videoMinutes / airborneMinutes, null if airborne 0
  datasetPosted: boolean;
  withinGrace: boolean;    // today <= date + grace working days
  reasons: string[];       // human-readable unmet conditions / exception note
}

// lib/resolutions.ts
export interface Resolution {
  date: string;            // YYYY-MM-DD flight day the exception applies to
  decision: "accepted_exception"; // S3 supports day-level accepted exceptions; S6 extends
  note: string;
  source: string;          // e.g. permalink or "manual"
  recordedAt: string;      // ISO
}
```

---

### Task 1: Shared working-day math — `lib/workdays.ts`

**Files:**
- Create: `lib/workdays.ts`, `lib/workdays.test.ts`
- Modify: `lib/policySchedule.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/workdays.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { addWorkingDays, isWorkingDay } from "./workdays";

describe("workdays", () => {
  it("isWorkingDay treats Sat/Sun as non-working", () => {
    expect(isWorkingDay("2026-05-04")).toBe(true); // Monday
    expect(isWorkingDay("2026-05-09")).toBe(false); // Saturday
    expect(isWorkingDay("2026-05-10")).toBe(false); // Sunday
  });

  it("addWorkingDays skips the weekend", () => {
    expect(addWorkingDays("2026-05-08", 1)).toBe("2026-05-11"); // Fri +1wd → Mon
    expect(addWorkingDays("2026-05-04", 0)).toBe("2026-05-04");
    expect(addWorkingDays("2026-06-18", 3)).toBe("2026-06-23"); // Thu +3wd → Tue
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/workdays.test.ts`
Expected: FAIL — `Failed to resolve import "./workdays"`.

- [ ] **Step 3: Create `lib/workdays.ts`** (move the exact logic from `lib/policySchedule.ts`)

```ts
/**
 * Pure working-day calendar math (Mon–Fri; public holidays not modeled), shared
 * by the policy scheduler and the field-day verdict. All dates are YYYY-MM-DD in
 * UTC — consistent with the rest of the repo's calendar math. No imports.
 */
function parseDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function fmtDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** ISO weekday: 1=Mon … 7=Sun. */
function isoWeekday(day: string): number {
  const dow = parseDay(day).getUTCDay(); // 0=Sun … 6=Sat
  return dow === 0 ? 7 : dow;
}

export function isWorkingDay(day: string): boolean {
  const wd = isoWeekday(day);
  return wd >= 1 && wd <= 5;
}

/** Add `n` working days (Mon–Fri) to a YYYY-MM-DD date; n=0 returns the input. */
export function addWorkingDays(day: string, n: number): string {
  const date = parseDay(day);
  let added = 0;
  while (added < n) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (isWorkingDay(fmtDay(date))) added += 1;
  }
  return fmtDay(date);
}
```

- [ ] **Step 4: Repoint `lib/policySchedule.ts` to the shared module**

In `lib/policySchedule.ts`: DELETE the local `parseDay`, `fmtDay`, `isoWeekday`, `isWorkingDay`, and `addWorkingDays` definitions. Add at the top of its imports:

```ts
import { addWorkingDays, isWorkingDay } from "./workdays";
```

Keep `lib/policySchedule.ts` re-exporting them so its existing importers (`scripts/policy.ts`, tests) keep working — add:

```ts
export { addWorkingDays, isWorkingDay } from "./workdays";
```

Note: `policySchedule.ts` still uses `parseDay`/`fmtDay` internally in `eachDate` and `lastDayOfMonth`/`monthsInPeriod`. Keep a LOCAL copy of just `parseDay` and `fmtDay` there (they're tiny) OR export them from workdays too. Simplest: keep `parseDay`/`fmtDay` local in `policySchedule.ts` (they're used by `eachDate`), and only move `isWorkingDay`/`addWorkingDays`/`isoWeekday` to workdays. `isoWeekday` becomes private to workdays; `policySchedule.ts` no longer needs it (only `occurrenceWindows` used `isoWeekday` for weekly cadence — keep a local `isoWeekday` in policySchedule for that one use, or import it). To avoid duplication, ALSO export `isoWeekday` from workdays and import it in policySchedule.

Concretely, `lib/workdays.ts` additionally exports:

```ts
/** ISO weekday: 1=Mon … 7=Sun. */
export function isoWeekday(day: string): number {
  const dow = parseDay(day).getUTCDay();
  return dow === 0 ? 7 : dow;
}
```

and `lib/policySchedule.ts` imports `{ addWorkingDays, isWorkingDay, isoWeekday }` from `./workdays`, keeps its own `parseDay`/`fmtDay` (used by `eachDate`), and re-exports `{ addWorkingDays, isWorkingDay }`.

- [ ] **Step 5: Run the full suite to verify nothing regressed**

Run: `npx vitest run lib/workdays.test.ts lib/policySchedule.test.ts && npm test`
Expected: all green (the existing policySchedule tests still pass via the re-export; new workdays tests pass).

- [ ] **Step 6: tsc + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add lib/workdays.ts lib/workdays.test.ts lib/policySchedule.ts
git commit -m "refactor(workdays): extract shared working-day math from policySchedule"
```

---

### Task 2: `videoFlightDate` — attribute a video by the date in its name

**Files:**
- Modify: `lib/reconcile.ts`
- Test: `lib/reconcile.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `lib/reconcile.test.ts` (import `videoFlightDate`):

```ts
import { videoFlightDate } from "./reconcile";

describe("videoFlightDate", () => {
  it("parses the `Recording YYYY-MM-DD …` name format", () => {
    expect(videoFlightDate("Recording 2026-06-16 195102", "2026-06-18T09:00:00Z")).toBe("2026-06-16");
  });

  it("parses the `WIN_YYYYMMDD_…` name format", () => {
    expect(videoFlightDate("WIN_20260616_17_39_24_Pro", "2026-06-18T09:00:00Z")).toBe("2026-06-16");
  });

  it("falls back to the Kyiv upload date when the name has no date", () => {
    // 2026-06-18T22:30:00Z is 2026-06-19 01:30 in Kyiv (UTC+3)
    expect(videoFlightDate("clip-final", "2026-06-18T22:30:00Z")).toBe("2026-06-19");
  });

  it("ignores an out-of-range fake date in the name and falls back", () => {
    expect(videoFlightDate("project_20261399_x", "2026-06-18T09:00:00Z")).toBe("2026-06-18");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/reconcile.test.ts -t videoFlightDate`
Expected: FAIL — `videoFlightDate` not exported.

- [ ] **Step 3: Implement `videoFlightDate` in `lib/reconcile.ts`** (add after `videoUploadDate`)

```ts
// Match YYYY-MM-DD or YYYYMMDD anywhere in the name. Capture the parts so we can
// validate the calendar date (a real date, not e.g. WIN_20261399).
const NAME_DATE_RE = /(\d{4})-(\d{2})-(\d{2})|(\d{4})(\d{2})(\d{2})/;

function validDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Reject impossible day-of-month (e.g. 2026-02-31) via round-trip.
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

/**
 * The flight day a video belongs to. Uploads lag the flight by up to the grace
 * window, so the flight date is taken from the video NAME — two observed formats,
 * `Recording YYYY-MM-DD …` and `WIN_YYYYMMDD_…`. Falls back to the Kyiv upload
 * date only when the name carries no parseable calendar date.
 * See docs/.../field-day-acceptance spec + memory video-name-carries-flight-date.
 */
export function videoFlightDate(name: string, createdTime: string): string {
  const m = NAME_DATE_RE.exec(name ?? "");
  if (m) {
    const iso = m[1]
      ? validDate(Number(m[1]), Number(m[2]), Number(m[3]))
      : validDate(Number(m[4]), Number(m[5]), Number(m[6]));
    if (iso) return iso;
  }
  return videoUploadDate(createdTime);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/reconcile.test.ts -t videoFlightDate`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/reconcile.ts lib/reconcile.test.ts
git commit -m "feat(reconcile): videoFlightDate — attribute by date in video name"
```

---

### Task 3: Dataset-notice recognizer — `lib/datasetNotice.ts`

**Files:**
- Create: `lib/datasetNotice.ts`, `lib/datasetNotice.test.ts`

The recognizer answers: did someone post a #datasets notice for flight day D within `[D, windowEnd]`? Keyword + date based; the date may be written as `YYYY-MM-DD`, `DD.MM.YYYY`, or `DD.MM`. Conservative: a message counts only if it both reads like a dataset notice (keyword) and references D, OR is an explicit "no dataset" note for D.

- [ ] **Step 1: Write the failing test**

Create `lib/datasetNotice.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hasDatasetNotice, type NoticeMessage } from "./datasetNotice";

const msg = (over: Partial<NoticeMessage>): NoticeMessage => ({
  isoTime: "2026-06-16T10:00:00.000Z",
  text: "",
  ...over,
});

describe("hasDatasetNotice", () => {
  it("matches a dataset keyword + ISO date within the window", () => {
    const msgs = [msg({ text: "Датасет за 2026-06-16 завантажено", isoTime: "2026-06-16T10:00:00Z" })];
    expect(hasDatasetNotice(msgs, "2026-06-16", "2026-06-19")).toBe(true);
  });

  it("matches the DD.MM.YYYY date format", () => {
    const msgs = [msg({ text: "датасет 16.06.2026 на драйві", isoTime: "2026-06-17T08:00:00Z" })];
    expect(hasDatasetNotice(msgs, "2026-06-16", "2026-06-19")).toBe(true);
  });

  it("matches an explicit no-dataset note for the day", () => {
    const msgs = [msg({ text: "16.06 немає датасету сьогодні", isoTime: "2026-06-16T18:00:00Z" })];
    expect(hasDatasetNotice(msgs, "2026-06-16", "2026-06-19")).toBe(true);
  });

  it("ignores a dataset message for a different date", () => {
    const msgs = [msg({ text: "Датасет за 2026-06-10", isoTime: "2026-06-16T10:00:00Z" })];
    expect(hasDatasetNotice(msgs, "2026-06-16", "2026-06-19")).toBe(false);
  });

  it("ignores a message posted after the window end", () => {
    const msgs = [msg({ text: "Датасет за 2026-06-16", isoTime: "2026-06-25T10:00:00Z" })];
    expect(hasDatasetNotice(msgs, "2026-06-16", "2026-06-19")).toBe(false);
  });

  it("ignores a dated message that lacks any dataset keyword", () => {
    const msgs = [msg({ text: "що там по 2026-06-16?", isoTime: "2026-06-16T10:00:00Z" })];
    expect(hasDatasetNotice(msgs, "2026-06-16", "2026-06-19")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/datasetNotice.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/datasetNotice.ts`**

```ts
/**
 * Pure recognizer: is there a #datasets notice for flight day D within the grace
 * window? A message counts when it (a) is posted in [D, windowEnd] (by day) and
 * (b) both reads like a dataset notice (keyword) and references D's date in any
 * common written form. An explicit "no dataset for D" note also counts (the team
 * may legitimately have nothing to publish that day).
 *
 * Recognition is intentionally conservative + evidence-surfacing — ambiguous
 * cases are confirmed by a human/LLM downstream, same posture as policy verdicts.
 * No imports; unit-tested.
 */
export interface NoticeMessage {
  isoTime: string;
  text: string;
}

// "датасет"/"dataset" (incl. Ukrainian cases), or an explicit "немає датасету".
const DATASET_KEYWORD = /датасет|dataset|немає\s+датасет/i;
const NO_DATASET = /немає\s+датасет|no\s+dataset/i;

/** All written forms of `date` (YYYY-MM-DD) a human might use. */
function dateNeedles(date: string): string[] {
  const [y, m, d] = date.split("-");
  return [
    `${y}-${m}-${d}`, // 2026-06-16
    `${d}.${m}.${y}`, // 16.06.2026
    `${d}.${m}`,      // 16.06
  ];
}

function referencesDate(text: string, date: string): boolean {
  return dateNeedles(date).some((needle) => text.includes(needle));
}

/**
 * @param messages #datasets messages (already restricted to that channel).
 * @param date flight day D (YYYY-MM-DD).
 * @param windowEnd inclusive last day a notice still counts (D + grace, YYYY-MM-DD).
 */
export function hasDatasetNotice(
  messages: NoticeMessage[],
  date: string,
  windowEnd: string,
): boolean {
  for (const m of messages) {
    const day = m.isoTime.slice(0, 10);
    if (day < date || day > windowEnd) continue;
    if (!referencesDate(m.text, date)) continue;
    if (DATASET_KEYWORD.test(m.text) || NO_DATASET.test(m.text)) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/datasetNotice.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/datasetNotice.ts lib/datasetNotice.test.ts
git commit -m "feat(datasets): pure #datasets notice recognizer"
```

---

### Task 4: Verdict logic — `lib/fieldDayVerdict.ts`

**Files:**
- Create: `lib/fieldDayVerdict.ts`, `lib/fieldDayVerdict.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/fieldDayVerdict.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { verdictForDay } from "./fieldDayVerdict";

const base = {
  flightDate: "2026-06-16",
  airborneMinutes: 20,
  videoMinutes: 12, // ratio 0.6 ≥ 0.5
  datasetPosted: true,
  today: "2026-06-30", // well after grace
  graceWorkingDays: 3,
};

describe("verdictForDay", () => {
  it("ACCEPTED when ratio ≥ 0.5 and a dataset notice exists", () => {
    const v = verdictForDay(base);
    expect(v.status).toBe("ACCEPTED");
    expect(v.ratio).toBeCloseTo(0.6);
  });

  it("PENDING when still within grace and a condition is unmet", () => {
    const v = verdictForDay({ ...base, datasetPosted: false, today: "2026-06-17" });
    expect(v.status).toBe("PENDING");
    expect(v.withinGrace).toBe(true);
  });

  it("NEEDS_REVIEW when grace elapsed and video < 50%", () => {
    const v = verdictForDay({ ...base, videoMinutes: 5, today: "2026-06-30" }); // ratio 0.25
    expect(v.status).toBe("NEEDS_REVIEW");
    expect(v.reasons.join(" ")).toMatch(/50%|video/i);
  });

  it("NEEDS_REVIEW when grace elapsed and no dataset notice", () => {
    const v = verdictForDay({ ...base, datasetPosted: false });
    expect(v.status).toBe("NEEDS_REVIEW");
    expect(v.reasons.join(" ")).toMatch(/dataset/i);
  });

  it("exact 50% passes the gate (>=)", () => {
    const v = verdictForDay({ ...base, airborneMinutes: 20, videoMinutes: 10 });
    expect(v.status).toBe("ACCEPTED");
  });

  it("ratio is null when airborne is 0 and the day NEEDS_REVIEW after grace", () => {
    const v = verdictForDay({ ...base, airborneMinutes: 0, videoMinutes: 0 });
    expect(v.ratio).toBeNull();
    expect(v.status).toBe("NEEDS_REVIEW");
  });

  it("grace boundary: today == flightDate + 3 wd is still within grace", () => {
    // 2026-06-16 (Tue) + 3 wd = 2026-06-19 (Fri)
    const v = verdictForDay({ ...base, datasetPosted: false, today: "2026-06-19" });
    expect(v.withinGrace).toBe(true);
    expect(v.status).toBe("PENDING");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/fieldDayVerdict.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/fieldDayVerdict.ts`**

```ts
/**
 * Pure per-flight-day acceptance verdict for the field bonus. Operationalizes the
 * recording-completeness gate: a day is ACCEPTED when, within the grace window,
 * Vimeo video minutes ≥ MIN_RATIO × airborne minutes AND a #datasets notice
 * exists. Inside the window with a condition unmet → PENDING. After the window
 * with a condition unmet → NEEDS_REVIEW (a human decides — never auto-rejected).
 *
 * No React/Next imports; unit-tested. Reuses MIN_RATIO and the shared working-day
 * math. See docs/.../field-day-acceptance spec (phase B).
 */
import { MIN_RATIO } from "./reconcile";
import { addWorkingDays } from "./workdays";

export type VerdictStatus = "ACCEPTED" | "PENDING" | "NEEDS_REVIEW" | "ACCEPTED_EXCEPTION";

export interface VerdictInput {
  flightDate: string;        // YYYY-MM-DD
  airborneMinutes: number;
  videoMinutes: number;
  datasetPosted: boolean;
  today: string;             // YYYY-MM-DD
  graceWorkingDays: number;
}

export interface DayVerdict {
  date: string;
  status: VerdictStatus;
  airborneMinutes: number;
  videoMinutes: number;
  ratio: number | null;
  datasetPosted: boolean;
  withinGrace: boolean;
  reasons: string[];
}

export function verdictForDay(input: VerdictInput): DayVerdict {
  const { flightDate, airborneMinutes, videoMinutes, datasetPosted, today, graceWorkingDays } = input;
  const ratio = airborneMinutes > 0 ? videoMinutes / airborneMinutes : null;
  const videoOk = ratio !== null && ratio >= MIN_RATIO;
  const windowEnd = addWorkingDays(flightDate, graceWorkingDays);
  const withinGrace = today <= windowEnd;

  const reasons: string[] = [];
  if (!videoOk) {
    reasons.push(
      ratio === null
        ? "no airborne time recorded for the day"
        : `video ${videoMinutes.toFixed(0)}m is ${(ratio * 100).toFixed(0)}% of airborne ${airborneMinutes.toFixed(0)}m (< 50%)`,
    );
  }
  if (!datasetPosted) reasons.push("no #datasets notice for the day");

  let status: VerdictStatus;
  if (videoOk && datasetPosted) {
    status = "ACCEPTED";
  } else if (withinGrace) {
    status = "PENDING";
  } else {
    status = "NEEDS_REVIEW";
  }

  return {
    date: flightDate,
    status,
    airborneMinutes,
    videoMinutes,
    ratio,
    datasetPosted,
    withinGrace,
    reasons,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/fieldDayVerdict.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/fieldDayVerdict.ts lib/fieldDayVerdict.test.ts
git commit -m "feat(verdict): pure verdictForDay (ACCEPTED/PENDING/NEEDS_REVIEW)"
```

---

### Task 5: Resolutions store — `lib/resolutions.ts`

**Files:**
- Create: `lib/resolutions.ts`, `lib/resolutions.test.ts`

A committed, durable record of human-confirmed exceptions, keyed by flight date. `applyResolution` flips a NEEDS_REVIEW verdict to ACCEPTED_EXCEPTION when a resolution exists for that day. Store path: `reports/resolutions/store.json` (single all-time file; NOT per-period — exceptions persist across periods). Read/write are fs (like `lib/reports.ts`, NOT server-only); the merge/apply logic is pure.

- [ ] **Step 1: Write the failing test**

Create `lib/resolutions.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyResolution,
  readResolutions,
  resolutionFor,
  upsertResolution,
  writeResolutions,
  type Resolution,
} from "./resolutions";
import type { DayVerdict } from "./fieldDayVerdict";

const res = (over: Partial<Resolution>): Resolution => ({
  date: "2026-06-13",
  decision: "accepted_exception",
  note: "force majeure — confirmed by Bogdan",
  source: "manual",
  recordedAt: "2026-06-19T00:00:00.000Z",
  ...over,
});

const needsReview: DayVerdict = {
  date: "2026-06-13",
  status: "NEEDS_REVIEW",
  airborneMinutes: 20,
  videoMinutes: 2,
  ratio: 0.1,
  datasetPosted: false,
  withinGrace: false,
  reasons: ["video < 50%"],
};

describe("resolutionFor / applyResolution", () => {
  it("flips NEEDS_REVIEW → ACCEPTED_EXCEPTION when a resolution exists for the day", () => {
    const out = applyResolution(needsReview, [res({})]);
    expect(out.status).toBe("ACCEPTED_EXCEPTION");
    expect(out.reasons.join(" ")).toMatch(/force majeure/);
  });

  it("leaves a verdict untouched when no resolution matches the date", () => {
    const out = applyResolution(needsReview, [res({ date: "2026-06-01" })]);
    expect(out.status).toBe("NEEDS_REVIEW");
  });

  it("does not override a non-NEEDS_REVIEW verdict", () => {
    const accepted = { ...needsReview, status: "ACCEPTED" as const };
    expect(applyResolution(accepted, [res({})]).status).toBe("ACCEPTED");
  });

  it("resolutionFor returns the matching resolution or undefined", () => {
    expect(resolutionFor("2026-06-13", [res({})])?.note).toMatch(/force majeure/);
    expect(resolutionFor("2026-06-14", [res({})])).toBeUndefined();
  });
});

describe("store I/O", () => {
  let baseDir: string;
  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "resolutions-"));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("round-trips; missing store → []", () => {
    expect(readResolutions({ baseDir })).toEqual([]);
    writeResolutions([res({})], { baseDir });
    expect(readResolutions({ baseDir })).toEqual([res({})]);
  });

  it("upsertResolution replaces by date, keeps others", () => {
    writeResolutions([res({ date: "2026-06-01" })], { baseDir });
    upsertResolution(res({ date: "2026-06-13" }), { baseDir });
    upsertResolution(res({ date: "2026-06-13", note: "updated" }), { baseDir });
    const all = readResolutions({ baseDir });
    expect(all).toHaveLength(2);
    expect(resolutionFor("2026-06-13", all)?.note).toBe("updated");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/resolutions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/resolutions.ts`**

```ts
/**
 * Durable, committed resolutions store — the agent's memory of human-confirmed
 * exceptions (e.g. "2026-06-13 force-majeure, accepted"). Consulted by the verdict
 * so a remembered exception flips NEEDS_REVIEW → ACCEPTED_EXCEPTION. Decisions are
 * auditable and reversible (edit/remove the entry).
 *
 * NOT server-only: fs-only, no secret (same precedent as lib/reports.ts). Stored
 * as a single all-time file reports/resolutions/store.json (exceptions persist
 * across periods, so it is not period-sharded). The apply/merge logic is pure.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DayVerdict } from "./fieldDayVerdict";

export interface Resolution {
  date: string;                     // YYYY-MM-DD flight day
  decision: "accepted_exception";   // S3 scope; S6 may add more
  note: string;
  source: string;                   // permalink or "manual"
  recordedAt: string;               // ISO
}

export interface ResolutionsOpts {
  baseDir?: string;
}

export function defaultBaseDir(): string {
  return join(process.cwd(), "reports");
}

function storePath(opts?: ResolutionsOpts): string {
  return join(opts?.baseDir ?? defaultBaseDir(), "resolutions", "store.json");
}

/** All resolutions (empty when the store is absent). */
export function readResolutions(opts?: ResolutionsOpts): Resolution[] {
  let raw: string;
  try {
    raw = readFileSync(storePath(opts), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return JSON.parse(raw) as Resolution[];
}

/** Overwrite the store atomically (temp + rename), mkdir -p. */
export function writeResolutions(resolutions: Resolution[], opts?: ResolutionsOpts): void {
  const path = storePath(opts);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(resolutions, null, 2));
  renameSync(tmp, path);
}

/** Insert or replace the resolution for its date, preserving the rest. */
export function upsertResolution(resolution: Resolution, opts?: ResolutionsOpts): void {
  const all = readResolutions(opts).filter((r) => r.date !== resolution.date);
  all.push(resolution);
  all.sort((a, b) => a.date.localeCompare(b.date));
  writeResolutions(all, opts);
}

/** The resolution for a flight day, if any. Pure. */
export function resolutionFor(date: string, resolutions: Resolution[]): Resolution | undefined {
  return resolutions.find((r) => r.date === date);
}

/**
 * Apply a remembered exception: a NEEDS_REVIEW verdict with a matching resolution
 * becomes ACCEPTED_EXCEPTION (note appended to reasons). Other statuses untouched.
 * Pure.
 */
export function applyResolution(verdict: DayVerdict, resolutions: Resolution[]): DayVerdict {
  if (verdict.status !== "NEEDS_REVIEW") return verdict;
  const match = resolutionFor(verdict.date, resolutions);
  if (!match) return verdict;
  return {
    ...verdict,
    status: "ACCEPTED_EXCEPTION",
    reasons: [...verdict.reasons, `exception: ${match.note}`],
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/resolutions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/resolutions.ts lib/resolutions.test.ts
git commit -m "feat(resolutions): committed resolutions store + applyResolution"
```

---

### Task 6: CLI — `scripts/fieldVerdictReport.ts` (pure) + `scripts/field-verdict.ts` + package.json

**Files:**
- Create: `scripts/fieldVerdictReport.ts`, `scripts/fieldVerdictReport.test.ts`, `scripts/field-verdict.ts`
- Modify: `package.json`

The report shape is the committed artifact = what `GET /api/field-verdict?period=` returns.

```ts
// scripts/fieldVerdictReport.ts — report types
export interface VerdictReport {
  period: { start: string; end: string };
  runDate: string;
  graceWorkingDays: number;
  days: DayVerdict[];            // from lib/fieldDayVerdict
  summary: {
    accepted: number;
    pending: number;
    needsReview: number;
    acceptedException: number;
  };
}
```

- [ ] **Step 1: Write the failing test for the pure shaping**

Create `scripts/fieldVerdictReport.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildReport, parseArgs, resolvePeriod, summarize, toCsv } from "./fieldVerdictReport";
import type { DayVerdict } from "../lib/fieldDayVerdict";

const day = (over: Partial<DayVerdict>): DayVerdict => ({
  date: "2026-06-16",
  status: "ACCEPTED",
  airborneMinutes: 20,
  videoMinutes: 12,
  ratio: 0.6,
  datasetPosted: true,
  withinGrace: false,
  reasons: [],
  ...over,
});

describe("parseArgs / resolvePeriod", () => {
  it("defaults to the current month when bounds omitted", () => {
    expect(resolvePeriod(parseArgs([]), "2026-06-19")).toEqual({ start: "2026-06-01", end: "2026-06-19" });
  });
  it("reads --start/--end and --write", () => {
    const a = parseArgs(["--start", "2026-05-01", "--end", "2026-05-31", "--write"]);
    expect(a.write).toBe(true);
    expect(resolvePeriod(a, "2026-06-19")).toEqual({ start: "2026-05-01", end: "2026-05-31" });
  });
});

describe("summarize / buildReport / toCsv", () => {
  it("counts each status", () => {
    const s = summarize([day({}), day({ status: "PENDING" }), day({ status: "NEEDS_REVIEW" }), day({ status: "ACCEPTED_EXCEPTION" })]);
    expect(s).toEqual({ accepted: 1, pending: 1, needsReview: 1, acceptedException: 1 });
  });

  it("buildReport assembles period + summary", () => {
    const r = buildReport([day({})], { start: "2026-06-01", end: "2026-06-30" }, "2026-06-30", 3);
    expect(r.summary.accepted).toBe(1);
    expect(r.days).toHaveLength(1);
  });

  it("toCsv emits a header + one row per day, escaping reasons", () => {
    const csv = toCsv(buildReport([day({ status: "NEEDS_REVIEW", reasons: ["video < 50%, no dataset"] })], { start: "2026-06-01", end: "2026-06-30" }, "2026-06-30", 3));
    expect(csv.split("\n")[0]).toBe("date,status,airborneMinutes,videoMinutes,ratio,datasetPosted,reasons");
    expect(csv).toMatch(/"video < 50%, no dataset"/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run scripts/fieldVerdictReport.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `scripts/fieldVerdictReport.ts`**

```ts
/**
 * Pure CLI shaping for the field-day verdict report: arg parsing, period
 * resolution, summary, table + CSV. No server/Next imports — unit-tested,
 * mirrors scripts/fieldopsReport.ts. Domain logic lives in ../lib/fieldDayVerdict.
 */
import type { DayVerdict } from "../lib/fieldDayVerdict";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type OutputFormat = "json" | "table";

export interface Period {
  start: string;
  end: string;
}

export interface ParsedArgs {
  start?: string;
  end?: string;
  format: OutputFormat;
  write: boolean;
}

export interface VerdictSummary {
  accepted: number;
  pending: number;
  needsReview: number;
  acceptedException: number;
}

export interface VerdictReport {
  period: Period;
  runDate: string;
  graceWorkingDays: number;
  days: DayVerdict[];
  summary: VerdictSummary;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { format: "json", write: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--start") { args.start = value; i += 1; }
    else if (flag === "--end") { args.end = value; i += 1; }
    else if (flag === "--format") { args.format = value === "table" ? "table" : "json"; i += 1; }
    else if (flag === "--write") { args.write = true; }
  }
  return args;
}

export function defaultMonthWindow(today: string): Period {
  return { start: `${today.slice(0, 7)}-01`, end: today };
}

export function resolvePeriod(args: ParsedArgs, today: string): Period {
  let start = args.start;
  let end = args.end;
  if (!start || !end) ({ start, end } = defaultMonthWindow(today));
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    throw new Error(`Period bounds must be YYYY-MM-DD: start=${start} end=${end}`);
  }
  return { start, end };
}

export function summarize(days: DayVerdict[]): VerdictSummary {
  const s: VerdictSummary = { accepted: 0, pending: 0, needsReview: 0, acceptedException: 0 };
  for (const d of days) {
    if (d.status === "ACCEPTED") s.accepted += 1;
    else if (d.status === "PENDING") s.pending += 1;
    else if (d.status === "NEEDS_REVIEW") s.needsReview += 1;
    else s.acceptedException += 1;
  }
  return s;
}

export function buildReport(days: DayVerdict[], period: Period, runDate: string, graceWorkingDays: number): VerdictReport {
  return { period, runDate, graceWorkingDays, days, summary: summarize(days) };
}

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(report: VerdictReport): string {
  const lines = ["date,status,airborneMinutes,videoMinutes,ratio,datasetPosted,reasons"];
  for (const d of report.days) {
    lines.push([
      d.date,
      d.status,
      String(d.airborneMinutes),
      String(d.videoMinutes),
      d.ratio === null ? "" : d.ratio.toFixed(3),
      String(d.datasetPosted),
      csvField(d.reasons.join("; ")),
    ].join(","));
  }
  return `${lines.join("\n")}\n`;
}

const STATUS_ICON: Record<string, string> = {
  ACCEPTED: "✅",
  PENDING: "⏳",
  NEEDS_REVIEW: "⚠️",
  ACCEPTED_EXCEPTION: "🟡",
};

export function formatTable(report: VerdictReport): string {
  const lines: string[] = [];
  lines.push(`Field-day verdict   ${report.period.start} … ${report.period.end}   (as of ${report.runDate}, grace ${report.graceWorkingDays}wd)`);
  lines.push("");
  lines.push("Date         Status               Air(m)  Vid(m)  Ratio  DS  Reasons");
  lines.push("----------   ------------------   ------  ------  -----  --  -------");
  if (report.days.length === 0) {
    lines.push("(no flight days in this period)");
  } else {
    for (const d of report.days) {
      lines.push(
        `${d.date}   ${(STATUS_ICON[d.status] ?? "") + " " + d.status).padEnd(18)}   ${String(d.airborneMinutes).padStart(6)}  ${String(d.videoMinutes).padStart(6)}  ${(d.ratio === null ? "—" : d.ratio.toFixed(2)).padStart(5)}  ${d.datasetPosted ? "✓ " : "✗ "}  ${d.reasons.join("; ")}`,
      );
    }
  }
  const s = report.summary;
  lines.push("");
  lines.push(`Totals: ✅ ${s.accepted}  ⏳ ${s.pending}  ⚠️ ${s.needsReview}  🟡 ${s.acceptedException}`);
  return lines.join("\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run scripts/fieldVerdictReport.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the CLI `scripts/field-verdict.ts`**

```ts
/**
 * CLI: compute the per-flight-day bonus-acceptance verdict for a window.
 *
 * Usage: npm run field-verdict -- --start 2026-06-01 --end 2026-06-19 [--format table]
 *        npm run field-verdict -- --start … --end … --write
 * Defaults to the current Europe/Kyiv month.
 *
 * Inputs:
 *  - airborne minutes per flight day ← committed reports/field-qa/<period>.json (S2)
 *  - video minutes per flight day    ← live Vimeo, attributed by videoFlightDate
 *  - #datasets notice per day         ← the local Slack mirror (run `npm run slack-sync` first)
 *  - exceptions                       ← reports/resolutions/store.json
 * `--write` persists reports/field-verdict/<period>.{json,csv}.
 *
 * Runs under `--conditions=react-server` so the server-only Vimeo import resolves.
 */
import { fetchVideosInPeriod } from "../lib/vimeo";
import { FIELD_TIMEZONE, videoFlightDate } from "../lib/reconcile";
import { readReportJson, writeReport, periodKey } from "../lib/reports";
import { readChannelMessages } from "../lib/slackMirror";
import { hasDatasetNotice } from "../lib/datasetNotice";
import { verdictForDay, type DayVerdict } from "../lib/fieldDayVerdict";
import { applyResolution, readResolutions } from "../lib/resolutions";
import { addWorkingDays } from "../lib/workdays";
import {
  buildReport,
  formatTable,
  parseArgs,
  resolvePeriod,
  toCsv,
  type Period,
} from "./fieldVerdictReport";

const GRACE_WORKING_DAYS = 3;
const DATASETS_CHANNEL = "datasets";

/** Shape of the committed field-qa report we read airborne minutes from (S2). */
interface FieldQaReport {
  days: { date: string; airborneMinutes: number }[];
}

function todayInFieldTz(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FIELD_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function main(): Promise<void> {
  try { process.loadEnvFile(); } catch { /* rely on ambient env */ }

  const args = parseArgs(process.argv.slice(2));
  const today = todayInFieldTz();
  const period: Period = resolvePeriod(args, today);

  // 1. Airborne minutes per flight day — committed S2 report.
  const fq = readReportJson<FieldQaReport>("field-qa", periodKey(period));
  if (!fq) {
    process.stderr.write(
      `field-verdict: no committed field-qa report for ${periodKey(period)} — run \`npm run field-qa -- --start ${period.start} --end ${period.end} --write\` first.\n`,
    );
  }
  const airborneByDate = new Map<string, number>(
    (fq?.days ?? []).map((d) => [d.date, d.airborneMinutes]),
  );

  // 2. Video minutes per flight day — live Vimeo, attributed by name date.
  const videos = await fetchVideosInPeriod(period.start, period.end);
  const videoMinutesByDate = new Map<string, number>();
  for (const v of videos) {
    const d = videoFlightDate(v.name, v.created_time);
    videoMinutesByDate.set(d, (videoMinutesByDate.get(d) ?? 0) + v.duration / 60);
  }

  // 3. #datasets notices — from the local Slack mirror (read-only).
  const datasetMessages = readChannelMessages(DATASETS_CHANNEL, period).map((m) => ({
    isoTime: m.isoTime,
    text: m.text,
  }));

  // 4. Resolutions (exceptions).
  const resolutions = readResolutions();

  // Flight days = days the bot reported airborne time (the field-qa report).
  const flightDates = [...airborneByDate.keys()].sort();
  const days: DayVerdict[] = flightDates.map((date) => {
    const airborneMinutes = airborneByDate.get(date) ?? 0;
    const videoMinutes = Math.round((videoMinutesByDate.get(date) ?? 0) * 10) / 10;
    const windowEnd = addWorkingDays(date, GRACE_WORKING_DAYS);
    const datasetPosted = hasDatasetNotice(datasetMessages, date, windowEnd);
    const base = verdictForDay({
      flightDate: date,
      airborneMinutes,
      videoMinutes,
      datasetPosted,
      today,
      graceWorkingDays: GRACE_WORKING_DAYS,
    });
    return applyResolution(base, resolutions);
  });

  const report = buildReport(days, period, today, GRACE_WORKING_DAYS);

  if (args.format === "table") console.log(formatTable(report));
  else console.log(JSON.stringify(report, null, 2));

  if (args.write) {
    const { jsonPath, csvPath } = writeReport("field-verdict", period, {
      json: JSON.stringify(report, null, 2),
      csv: toCsv(report),
    });
    const s = report.summary;
    process.stderr.write(
      `field-verdict: wrote ${jsonPath} and ${csvPath} (✅${s.accepted} ⏳${s.pending} ⚠️${s.needsReview} 🟡${s.acceptedException})\n`,
    );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`field-verdict: ${message}\n`);
  process.exit(1);
});
```

- [ ] **Step 6: Add the npm script**

In `package.json` `scripts`, after `"field-qa"`:

```json
    "field-verdict": "node --conditions=react-server --import tsx scripts/field-verdict.ts",
```

- [ ] **Step 7: Verify + live smoke**

Run: `npx tsc --noEmit && npm run lint && npm test` — all green.
Then (the mirror + field-qa report should exist; if not, the CLI prints guidance):
`npm run slack-sync -- init` then `npm run field-qa -- --start 2026-06-01 --end 2026-06-19 --write` then `npm run field-verdict -- --start 2026-06-01 --end 2026-06-19 --format table`.
Expected: a per-day table with statuses; `--write` then `git status --porcelain reports/field-verdict/` shows the new artifact (it IS committed — reports/ is tracked).

- [ ] **Step 8: Commit**

```bash
git add scripts/fieldVerdictReport.ts scripts/fieldVerdictReport.test.ts scripts/field-verdict.ts package.json
git commit -m "feat(field-verdict): CLI computing per-day acceptance verdict + artifact"
```

---

### Task 7: Web surface — API route + dashboard tab

**Files:**
- Create: `app/api/field-verdict/route.ts`, `app/(dashboard)/field-verdict/page.tsx`
- Modify: `app/(dashboard)/layout.tsx`

Mirror `app/api/field-ops/route.ts` (committed-only is acceptable here — like field-ops, the verdict has no pure-live path because datasets come from the mirror) and the `lib/usePeriodReport` pattern. Read these three files first to copy the exact patterns: `app/api/field-ops/route.ts`, `app/(dashboard)/field-ops/page.tsx`, `app/(dashboard)/layout.tsx`.

- [ ] **Step 1: API route** `app/api/field-verdict/route.ts`

```ts
import { NextResponse } from "next/server";
import { listPeriods, parsePeriodKey, readReportJson } from "@/lib/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);

  if (searchParams.get("periods") === "1") {
    return NextResponse.json({ periods: listPeriods("field-verdict") });
  }

  const period = searchParams.get("period");
  if (period) {
    if (!parsePeriodKey(period)) {
      return NextResponse.json({ error: `Invalid period key: ${period}` }, { status: 400 });
    }
    const report = readReportJson("field-verdict", period);
    if (!report) {
      return NextResponse.json({ error: `No committed report for ${period}` }, { status: 404 });
    }
    return NextResponse.json(report);
  }

  return NextResponse.json({ error: "Provide ?periods=1 or ?period=<key>" }, { status: 400 });
}
```

- [ ] **Step 2: Dashboard tab** `app/(dashboard)/field-verdict/page.tsx`

Use the `lib/usePeriodReport` hook exactly as `app/(dashboard)/field-ops/page.tsx` does (committed-only; no live refresh). Render a table of `report.days` with the status (icon + label), airborne/video minutes, ratio, dataset ✓/✗, and reasons; show the summary counts. Read `app/(dashboard)/field-ops/page.tsx` and copy its structure/styling; swap the data shape to `VerdictReport` (`days[]` + `summary`). Keep it a `"use client"` component. Do NOT import any `node:fs`/server-only module.

(The implementer should reproduce the field-ops page's committed-render structure with the verdict columns; the exact JSX follows that file's conventions — match its Tailwind classes and empty/loading/error states.)

- [ ] **Step 3: Nav entry** in `app/(dashboard)/layout.tsx`

Add a nav item for Field Verdict (path `/field-verdict`, `enabled: true`) following the existing data-driven nav array shape. Read the file and match the existing entries exactly.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npm run lint && npm test && npm run build`
Expected: build succeeds (proves the new client page pulls in no server-only/node:fs). Manually: `npm run dev`, open `/field-verdict`, pick the committed period, confirm it renders the same numbers as the CLI table.

- [ ] **Step 5: Commit**

```bash
git add app/api/field-verdict/route.ts "app/(dashboard)/field-verdict/page.tsx" "app/(dashboard)/layout.tsx"
git commit -m "feat(field-verdict): hybrid API route + dashboard tab"
```

---

## Final verification (after all tasks)

- [ ] `npm test` — all green (existing + new workdays/reconcile/datasetNotice/fieldDayVerdict/resolutions/fieldVerdictReport suites).
- [ ] `npm run lint` + `npx tsc --noEmit` — clean.
- [ ] `npm run build` — succeeds.
- [ ] End-to-end: `npm run slack-sync -- init` → `npm run field-qa -- … --write` → `npm run field-verdict -- … --format table` prints sensible verdicts; `--write` then `/field-verdict` web tab renders identically.
- [ ] `git status --porcelain data/` empty (mirror still ignored); `reports/field-verdict/<period>.json` IS tracked.

## Notes for the implementer

- **Server-only discipline:** `scripts/field-verdict.ts` runs under `--conditions=react-server`; it imports the server-only `lib/vimeo`. `lib/fieldDayVerdict.ts`, `lib/datasetNotice.ts`, `lib/workdays.ts` are pure (no fs, no server-only). `lib/resolutions.ts` is fs-only (NOT server-only), like `lib/reports.ts`. The web page is `"use client"` and must import none of these fs/server modules — only fetch via the API route.
- **Relative imports** in `lib/`/`scripts/` and their tests; the API route + web page use the `@/` alias (App Router convention) like the existing routes/pages.
- **Don't regress policy:** Task 1 must keep `lib/policySchedule.test.ts` green via the re-export.
- **Out of scope (S4–S6, separate plan):** no Slack posting, no ask state machine, no LLM answer classifier, no writes to the resolutions store from Slack. S3 only READS resolutions (the store is hand/`upsertResolution`-seeded until S6).
