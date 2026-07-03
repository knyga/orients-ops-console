# Unified Flight-Day Qualification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One qualification gate — the verdict — behind both the Slack «прийнято» messages and the bonus payout: ACCEPTED ⇔ pays.

**Architecture:** `verdictForDay` (pure, `lib/fieldDayVerdict.ts`) gains the missing axes (deploy ≥ 3h, 2-min video floor, drone-report presence, no-Звіт detection) and becomes the single gate; hard fails auto-REJECT. `computeBonuses` (pure, `lib/fieldBonus.ts`) stops evaluating gates and pays settled verdict days (ACCEPTED / ACCEPTED_EXCEPTION), listing unsettled days as `pendingDays`. The orchestrator `lib/computeBonuses.ts` calls `computeVerdicts` instead of running its own Vimeo/drone-gate pipeline.

**Tech Stack:** TypeScript strict, Vitest (server-only aliased to empty via `vitest.config.ts`; mock deps with `vi.hoisted`), Next 16 App Router.

**Spec:** `docs/superpowers/specs/2026-07-03-unified-day-qualification-design.md` — read it first.

## Global Constraints

- A peer session is executing the 2026-07-02 drone-counts plan on this same checkout. **Run `git log --oneline -5` and `git status` before each task**; rebase your mental model on any new commits. Base state for this plan: commit `7430176`.
- Pure `lib/` modules stay pure (no React/Next/server imports in `fieldDayVerdict.ts`, `fieldBonus.ts`, `verdictPublish.ts`).
- All team-facing Slack copy is Ukrainian; English reasons stay in report JSON/CSV/web.
- Ukrainian renders derive from **structured DayVerdict fields**, never by parsing the English `reasons` strings.
- Gate constants: `MIN_DEPLOY_MIN = 180`, `MIN_VIDEO_MIN = 2`, `MIN_RATIO = 0.5` (existing, `lib/reconcile.ts`).
- Never run `field-publish`/`field-backfill` with `--publish` — team-facing sends are the operator's call.
- Commit after every task; end commit messages with the Claude Code trailer.

---

### Task 1: The unified gate in `verdictForDay`

**Files:**
- Modify: `lib/fieldDayVerdict.ts`
- Modify: `lib/fieldBonus.ts:15-16` (constants move here → re-export)
- Test: `lib/fieldDayVerdict.test.ts`

**Interfaces:**
- Consumes: `MIN_RATIO` from `lib/reconcile.ts`, `addWorkingDays` from `lib/workdays.ts` (existing).
- Produces: `MIN_DEPLOY_MIN: 180`, `MIN_VIDEO_MIN: 2` (exported constants); `VerdictInput` gains `deployMin?: number | null`, `droneReportPresent?: boolean`, `hasZvit?: boolean`; `DayVerdict` gains `deployMin?: number | null`, `droneReportPresent?: boolean`, `hasZvit?: boolean` (optional — absent means "true"/ungated, so old committed JSON and existing fixtures stay valid). Tasks 2–5 rely on these exact names.

- [ ] **Step 1: Write the failing tests** — append to `lib/fieldDayVerdict.test.ts` (existing style: plain `verdictForDay({...})` calls):

```ts
describe("unified gate axes", () => {
  // 2026-06-30 shape: video 29m vs 18.1m airborne (160%), dataset posted.
  const base = {
    flightDate: "2026-06-30",
    airborneMinutes: 18.1,
    videoMinutes: 29,
    datasetStatus: "POSTED" as const,
    today: "2026-07-03",
    graceWorkingDays: 3,
  };

  it("REJECTS a flown day whose deployment is under 3h (hard fail)", () => {
    const v = verdictForDay({ ...base, deployMin: 120 });
    expect(v.status).toBe("REJECTED");
    expect(v.reasons).toContain("deployment 120m is under 3h");
  });

  it("ACCEPTS when deploy >= 180 and every other axis passes", () => {
    const v = verdictForDay({ ...base, deployMin: 240, droneReportPresent: true, hasZvit: true });
    expect(v.status).toBe("ACCEPTED");
  });

  it("REJECTS a flown day with no drone-count report (hard fail)", () => {
    const v = verdictForDay({ ...base, deployMin: 240, droneReportPresent: false });
    expect(v.status).toBe("REJECTED");
    expect(v.reasons).toContain("no drone-count report in #field-qa");
  });

  it("hard fail outranks curable gaps (short deploy + missing dataset → REJECTED, not PENDING)", () => {
    const v = verdictForDay({ ...base, datasetStatus: "MISSING", deployMin: 120 });
    expect(v.status).toBe("REJECTED");
  });

  it("Звіт without a deploy window is a curable gap: PENDING in grace, NEEDS_REVIEW after", () => {
    expect(verdictForDay({ ...base, deployMin: null }).status).toBe("PENDING");
    const late = verdictForDay({ ...base, deployMin: null, today: "2026-07-10" });
    expect(late.status).toBe("NEEDS_REVIEW");
    expect(late.reasons).toContain("deployment window not recorded in the Звіт");
  });

  it("a flown day with no Звіт at all can never auto-accept", () => {
    const v = verdictForDay({ ...base, hasZvit: false, today: "2026-07-10" });
    expect(v.status).toBe("NEEDS_REVIEW");
    expect(v.reasons).toContain("flight detected but no Звіт (crew/deployment unknown)");
  });

  it("video under the 2-minute floor fails even when the 50% ratio passes", () => {
    const v = verdictForDay({ ...base, airborneMinutes: 2, videoMinutes: 1.5, deployMin: 240 });
    expect(v.status).toBe("PENDING");
    expect(v.reasons).toContain("video 1.5m is under the 2-minute floor");
  });

  it("a no-fly day is never hard-rejected for deploy/drone axes", () => {
    const v = verdictForDay({
      ...base, airborneMinutes: 0, videoMinutes: 0, droneReportPresent: false, deployMin: 120,
    });
    expect(v.status).toBe("PENDING"); // did-not-fly stays a review path, not a rejection
  });

  it("legacy input (no new fields) keeps today's behavior", () => {
    const v = verdictForDay(base);
    expect(v.status).toBe("ACCEPTED");
    expect(v.droneReportPresent).toBe(true);
    expect(v.hasZvit).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run lib/fieldDayVerdict.test.ts`
Expected: FAIL — new cases red (REJECTED paths return ACCEPTED/PENDING; missing reasons), original 16 still pass.

- [ ] **Step 3: Implement.** Replace `lib/fieldDayVerdict.ts` body (keep `VerdictStatus`, `DatasetStatus`, imports):

Top doc comment — replace the last sentence of the first paragraph ("Inside the window … never auto-rejected.") with:

```
 * The gate has four axes: deployment >= 3h, video >= max(2 min, 50% x airborne),
 * a #field-qa drone-count report, and a #datasets notice. Three failures are
 * machine auto-rejects (hard no-pay, admin can override via the instruction
 * path): an admin-declined dataset, a deployment under 3h, and a missing
 * drone-count report. Curable gaps stay PENDING inside the grace window and
 * NEEDS_REVIEW after. ACCEPTED ⇔ the crew is paid for the day (see the
 * 2026-07-03 unified-day-qualification spec).
```

```ts
export const MIN_DEPLOY_MIN = 180;
export const MIN_VIDEO_MIN = 2;

export interface VerdictInput {
  flightDate: string;        // YYYY-MM-DD
  airborneMinutes: number;
  videoMinutes: number;
  datasetStatus: DatasetStatus;
  today: string;             // YYYY-MM-DD
  graceWorkingDays: number;
  /** false when the day was surfaced from a "Звіт" that reported no airborne time. Defaults true. */
  airborneReported?: boolean;
  /** Reported deployment window, when known (for the honest message). */
  deployWindow?: { start: string; end: string };
  /** Звіт deployment minutes: number → gate on it; null → Звіт without a window (curable gap); undefined → unknown source (don't gate). */
  deployMin?: number | null;
  /** false when no drone-count report was attributed to this flight day. Defaults true (unknown → don't gate). */
  droneReportPresent?: boolean;
  /** false when the day has no parsed "Звіт" at all (nobody attributable to pay). Defaults true. */
  hasZvit?: boolean;
}
```

`DayVerdict` — add after `deployWindow`:

```ts
  /** Звіт deployment minutes (gate axis); absent on legacy reports. */
  deployMin?: number | null;
  /** false when no drone-count report was attributed to the day; absent = ungated. */
  droneReportPresent?: boolean;
  /** false when the day has no parsed "Звіт"; absent = true. */
  hasZvit?: boolean;
```

```ts
export function verdictForDay(input: VerdictInput): DayVerdict {
  const { flightDate, airborneMinutes, videoMinutes, datasetStatus, today, graceWorkingDays } = input;
  const airborneReported = input.airborneReported ?? true;
  const droneReportPresent = input.droneReportPresent ?? true;
  const hasZvit = input.hasZvit ?? true;
  const deployMin = input.deployMin;
  const ratio = airborneMinutes > 0 ? videoMinutes / airborneMinutes : null;
  const videoOk = ratio !== null && ratio >= MIN_RATIO && videoMinutes >= MIN_VIDEO_MIN;
  const datasetOk = datasetStatus === "POSTED" || datasetStatus === "WAIVED";
  const windowEnd = addWorkingDays(flightDate, graceWorkingDays);
  const withinGrace = today <= windowEnd;
  // Deploy/drone/Звіт axes only bind when the day actually flew — a no-fly day
  // has no pay at stake and stays on the review path.
  const flew = airborneMinutes > 0 || !airborneReported;
  const deployShort = flew && typeof deployMin === "number" && deployMin < MIN_DEPLOY_MIN; // hard fail
  const deployUnknown = flew && deployMin === null;                                        // curable gap
  const droneMissing = flew && !droneReportPresent;                                        // hard fail
  const noZvit = flew && !hasZvit;                                                         // curable gap

  const reasons: string[] = [];
  if (!videoOk) {
    if (ratio === null) {
      reasons.push(
        airborneReported
          ? "drones did not fly (0 flights, 0 min airborne)"
          : "flight reported but airborne time not recorded",
      );
    } else if (ratio < MIN_RATIO) {
      reasons.push(`video ${videoMinutes.toFixed(0)}m is ${(ratio * 100).toFixed(0)}% of airborne ${airborneMinutes.toFixed(0)}m (< 50%)`);
    } else {
      reasons.push(`video ${videoMinutes.toFixed(1)}m is under the ${MIN_VIDEO_MIN}-minute floor`);
    }
  }
  if (deployShort) reasons.push(`deployment ${deployMin}m is under 3h`);
  if (deployUnknown) reasons.push("deployment window not recorded in the Звіт");
  if (droneMissing) reasons.push("no drone-count report in #field-qa");
  if (noZvit) reasons.push("flight detected but no Звіт (crew/deployment unknown)");
  if (datasetStatus === "MISSING") reasons.push("no #datasets notice for the day");
  if (datasetStatus === "WAIVED") reasons.push("no dataset — reason accepted (waived)");
  if (datasetStatus === "DECLINED") reasons.push("dataset reason declined by an admin");

  let status: VerdictStatus;
  if (datasetStatus === "DECLINED" || deployShort || droneMissing) {
    status = "REJECTED";
  } else if (videoOk && datasetOk && !deployUnknown && !noZvit) {
    status = "ACCEPTED";
  } else if (withinGrace) {
    status = "PENDING";
  } else {
    status = "NEEDS_REVIEW";
  }

  return {
    date: flightDate, status, airborneMinutes, videoMinutes, ratio, datasetStatus, withinGrace,
    reasons, roster: [], unknownInitials: [], airborneReported, deployWindow: input.deployWindow,
    deployMin, droneReportPresent, hasZvit,
  };
}
```

In `lib/fieldBonus.ts`, delete lines 15–16 (`export const MIN_DEPLOY_MIN…MIN_VIDEO_MIN`) and add at the top:

```ts
export { MIN_DEPLOY_MIN, MIN_VIDEO_MIN } from "./fieldDayVerdict";
import { MIN_DEPLOY_MIN, MIN_VIDEO_MIN } from "./fieldDayVerdict";
```

(The calculator still uses them until Task 4 removes its gate; existing importers `lib/computeBonuses.ts` keep working.)

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run lib/fieldDayVerdict.test.ts lib/fieldBonus.test.ts lib/verdictPublish.test.ts lib/backfillPublished.test.ts && npm run lint`
Expected: PASS. If a pre-existing fixture fails on the new 2-minute floor (ratio ≥ 50% with video < 2 min), that behavior change is **intended by the spec** — update the fixture's expectation and note it in the commit message.

- [ ] **Step 5: Commit**

```bash
git add lib/fieldDayVerdict.ts lib/fieldDayVerdict.test.ts lib/fieldBonus.ts
git commit -m "feat(verdict): unified gate axes — deploy >=3h, 2-min video floor, drone report, no-Звіт"
```

---

### Task 2: Thread the new axes through `computeVerdicts`

**Files:**
- Modify: `lib/computeVerdicts.ts:107-137` (the `days` map) and add one flag above it

**Interfaces:**
- Consumes: Task 1's `VerdictInput` fields; `parsedByDate` / `droneByDate` already in scope (`lib/computeVerdicts.ts:74-99`).
- Produces: verdict report `days[]` now carry `deployMin`, `droneReportPresent`, `hasZvit` — Task 5 reads them.

- [ ] **Step 1: Implement** (no test file exists for this server-only orchestrator; it is covered by Task 1 units + the Task 7 June verification). After the `droneByDate` construction (line ~77) add:

```ts
  // Legacy committed field-qa reports predate the drone extraction; never
  // mass-reject on absent data — skip the drone gate and say so.
  const droneDataAvailable = (fq?.days ?? []).some((d) => d.droneReport !== undefined);
  if (fq && !droneDataAvailable) {
    log(`field-verdict: field-qa report for ${periodKey(period)} has no droneReport data — drone-count gate skipped (re-run \`npm run field-qa -- --write\`)`);
  }
```

In the `days` map (line ~107), move the parsed-report lookup **above** the `verdictForDay` call (it currently sits below, feeding the roster) and extend the call:

```ts
    const parsed = parsedByDate.get(date);
    const base = verdictForDay({
      flightDate: date,
      airborneMinutes,
      videoMinutes,
      datasetStatus,
      today,
      graceWorkingDays: GRACE_WORKING_DAYS,
      airborneReported: fd.airborneReported,
      deployWindow: fd.deployWindow,
      deployMin: parsed ? parsed.deployMin : undefined,
      hasZvit: parsed != null,
      ...(droneDataAvailable ? { droneReportPresent: (droneByDate.get(date)?.length ?? 0) > 0 } : {}),
    });
```

Delete the now-duplicate `const parsed = parsedByDate.get(date);` further down (line ~128); the roster attachment below keeps using `parsed`.

- [ ] **Step 2: Typecheck + suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS (no behavior change for callers until data flows).

- [ ] **Step 3: Commit**

```bash
git add lib/computeVerdicts.ts
git commit -m "feat(verdict): wire deployMin/hasZvit/droneReportPresent into the day gate"
```

---

### Task 3: Ukrainian rendering — REJECTED days + new gap phrases

**Files:**
- Modify: `lib/verdictPublish.ts` (`ICON`, `publishableDays`, `formatDayMessage`, `ukrainianGaps`)
- Test: `lib/verdictPublish.test.ts`

**Interfaces:**
- Consumes: `DayVerdict.deployMin` / `.droneReportPresent` / `.hasZvit` (Task 1), `MIN_DEPLOY_MIN`, `MIN_VIDEO_MIN` from `lib/fieldDayVerdict.ts`.
- Produces: `publishableDays` now includes REJECTED (nightly publish + backfill pick this up with no further change); `formatDayMessage` renders `⛔ … — відхилено: …`.

- [ ] **Step 1: Write failing tests** (existing fixtures build `DayVerdict` literals — the new fields are optional, so they still compile):

```ts
describe("REJECTED rendering", () => {
  const rejected: DayVerdict = {
    date: "2026-06-30", status: "REJECTED", airborneMinutes: 18.1, videoMinutes: 29,
    ratio: 29 / 18.1, datasetStatus: "POSTED", withinGrace: false,
    reasons: ["deployment 120m is under 3h"], roster: ["Влад", "Любомир"],
    unknownInitials: [], airborneReported: true, deployMin: 120, droneReportPresent: true, hasZvit: true,
  };

  it("renders відхилено with the short-deploy gap in Ukrainian", () => {
    const msg = formatDayMessage(rejected);
    expect(msg).toContain("⛔ 2026-06-30");
    expect(msg).toContain("відхилено: виїзд 120 хв — менше 3 год");
    expect(msg).toContain("👥 У полі: Влад, Любомир.");
    expect(msg).not.toMatch(/прийнято/);
  });

  it("renders the missing-drone-report gap", () => {
    const msg = formatDayMessage({ ...rejected, deployMin: 240, droneReportPresent: false, reasons: ["no drone-count report in #field-qa"] });
    expect(msg).toContain("немає звіту про кількість дронів у #field-qa");
  });

  it("REJECTED days are publishable", () => {
    expect(publishableDays([rejected])).toHaveLength(1);
  });
});

describe("new curable-gap phrases", () => {
  it("no-Звіт day", () => {
    const day: DayVerdict = {
      date: "2026-06-03", status: "NEEDS_REVIEW", airborneMinutes: 42.75, videoMinutes: 36,
      ratio: 36 / 42.75, datasetStatus: "POSTED", withinGrace: false, reasons: [], roster: [],
      unknownInitials: [], airborneReported: true, hasZvit: false,
    };
    expect(formatDayMessage(day)).toContain("політ зафіксовано, але немає Звіту (екіпаж невідомий)");
  });

  it("deploy window not recorded", () => {
    const day: DayVerdict = {
      date: "2026-06-16", status: "NEEDS_REVIEW", airborneMinutes: 36.48, videoMinutes: 93,
      ratio: 93 / 36.48, datasetStatus: "POSTED", withinGrace: false, reasons: [], roster: ["Андріан", "Надія"],
      unknownInitials: [], airborneReported: true, deployMin: null, hasZvit: true,
    };
    expect(formatDayMessage(day)).toContain("у Звіті не вказано час виїзду");
  });

  it("video under the 2-minute floor", () => {
    const day: DayVerdict = {
      date: "2026-06-05", status: "NEEDS_REVIEW", airborneMinutes: 2, videoMinutes: 1.5,
      ratio: 0.75, datasetStatus: "POSTED", withinGrace: false, reasons: [], roster: [],
      unknownInitials: [], airborneReported: true,
    };
    expect(formatDayMessage(day)).toContain("відео 1.5 хв — менше 2 хв");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/verdictPublish.test.ts`
Expected: FAIL — no ⛔ icon/branch, `publishableDays` filters REJECTED out, gaps missing.

- [ ] **Step 3: Implement.**

`ICON` map: add `REJECTED: "⛔"`. `publishableDays`: add `d.status === "REJECTED"` to the filter (and extend its doc comment: REJECTED is a settled machine outcome the team must see). Update the module doc comment's "Only SETTLED…" sentence to include REJECTED.

Imports: `import { MIN_RATIO } from "./reconcile";` already present; add `import { MIN_DEPLOY_MIN, MIN_VIDEO_MIN } from "./fieldDayVerdict";` (type import already exists — extend it).

In `formatDayMessage`, before the ACCEPTED branch:

```ts
  if (day.status === "REJECTED") {
    const tail = day.airborneReported && day.airborneMinutes > 0
      ? `(відео ${vid} хв / ${air} хв у повітрі, ${ds})`
      : `(відео ${vid} хв, ${ds})`;
    return withDroneLine(
      withRosterSuffix(`⛔ ${date} — відхилено: ${ukrainianGaps(day).join("; ")} ${tail}.`, day.roster),
      day.droneReport,
    );
  }
```

In `ukrainianGaps`, after the video block (keep its existing branches; add the floor case) and before the dataset lines:

```ts
  const flew = day.airborneMinutes > 0 || !day.airborneReported;
  if (videoOk === false && day.ratio !== null && day.ratio >= MIN_RATIO) {
    // ratio passed but the absolute floor did not
    gaps.push(`відео ${day.videoMinutes.toFixed(1)} хв — менше ${MIN_VIDEO_MIN} хв`);
  }
  if (flew && day.deployMin != null && day.deployMin < MIN_DEPLOY_MIN) gaps.push(`виїзд ${day.deployMin} хв — менше 3 год`);
  if (flew && day.deployMin === null) gaps.push("у Звіті не вказано час виїзду");
  if (flew && day.droneReportPresent === false) gaps.push("немає звіту про кількість дронів у #field-qa");
  if (flew && day.hasZvit === false) gaps.push("політ зафіксовано, але немає Звіту (екіпаж невідомий)");
```

and change the local `videoOk` to match the gate: `const videoOk = day.ratio !== null && day.ratio >= MIN_RATIO && day.videoMinutes >= MIN_VIDEO_MIN;` — the existing `<50%` / ratio-null branches must only fire when `day.ratio === null || day.ratio < MIN_RATIO` (restructure the first `if (!videoOk)` block accordingly so the floor case doesn't emit the percentage phrase). Add the declined-dataset phrase for REJECTED renders:

```ts
  if (day.datasetStatus === "DECLINED") gaps.push("датасет відхилено адміністратором");
```

- [ ] **Step 4: Run the suite**

Run: `npx vitest run lib/verdictPublish.test.ts lib/publishVerdicts.test.ts lib/backfillPublished.test.ts`
Expected: PASS (round-trip/region tests unaffected — the ⛔ body is still a single first region).

- [ ] **Step 5: Commit**

```bash
git add lib/verdictPublish.ts lib/verdictPublish.test.ts
git commit -m "feat(publish): render REJECTED verdicts (відхилено) + unified-gate gap phrases"
```

---

### Task 4: `computeBonuses` pays verdict days (pure calculator)

**Files:**
- Modify: `lib/fieldBonus.ts`
- Test: `lib/fieldBonus.test.ts` (fixtures rewritten to the new input)

**Interfaces:**
- Consumes: `VerdictStatus` type (Task 1 file).
- Produces (Task 5/6 rely on these exact shapes):

```ts
export interface QualifiedDay {
  date: string;
  status: VerdictStatus;
  roster: string[];
  unknownInitials: string[];
  deployMin: number | null;
  videoMin: number;
  start: string | null;   // Звіт arrival "HH:MM" for the early bonus
  reasons: string[];
  flew: boolean;          // pending money is only at stake when the day flew
}
export interface PendingDay { date: string; roster: string[]; status: VerdictStatus; reasons: string[]; amountAtStake: number }
export interface DayBonus { date: string; roster: string[]; deployMin: number | null; videoMin: number; counted: boolean; early: boolean; weekend: boolean; reason: string; status: VerdictStatus }
export interface BonusReport { period: Period; days: DayBonus[]; people: PersonBonus[]; penalties: Penalty[]; teamZeroed: boolean; flags: Flag[]; total: number; voidedDays: { date: string; roster: string[]; reason: string }[]; pendingDays: PendingDay[] }
export function computeBonuses(input: { period: Period; days: QualifiedDay[]; losses: LossRecord[]; corrections?: RosterCorrection[] }): BonusReport
```

- [ ] **Step 1: Rewrite the tests.** Replace the gate-oriented fixtures in `lib/fieldBonus.test.ts` with a day builder and status-driven cases (keep the loss/penalty/team-zero cases, adapting their inputs):

```ts
import { computeBonuses, TRIP, EARLY, WEEKEND, type QualifiedDay } from "./fieldBonus";

const PERIOD = { start: "2026-06-01", end: "2026-06-30" };
const qd = (over: Partial<QualifiedDay>): QualifiedDay => ({
  date: "2026-06-02", status: "ACCEPTED", roster: ["Андріан", "Надія"], unknownInitials: [],
  deployMin: 270, videoMin: 44.8, start: "13:00", reasons: [], flew: true, ...over,
});

describe("status-driven pay", () => {
  it("pays ACCEPTED and ACCEPTED_EXCEPTION days only", () => {
    const r = computeBonuses({ period: PERIOD, losses: [], days: [
      qd({}),                                                        // pays
      qd({ date: "2026-06-21", status: "ACCEPTED_EXCEPTION", roster: ["Андріан", "Сергій"] }), // pays (Sunday)
      qd({ date: "2026-06-27", status: "NEEDS_REVIEW", reasons: ["no #datasets notice for the day"] }),
      qd({ date: "2026-06-30", status: "REJECTED", deployMin: 120, reasons: ["deployment 120m is under 3h"], roster: ["Влад", "Любомир"] }),
    ]});
    const andrian = r.people.find((p) => p.name === "Андріан")!;
    expect(andrian.trips).toBe(2);
    expect(andrian.weekend).toBe(1); // 06-21 is a Sunday
    expect(r.people.find((p) => p.name === "Влад")).toBeUndefined();
  });

  it("collects unsettled flown days into pendingDays with the amount at stake", () => {
    const r = computeBonuses({ period: PERIOD, losses: [], days: [
      qd({ date: "2026-06-27", status: "NEEDS_REVIEW", roster: ["Андріан", "Сергій"], reasons: ["no #datasets notice for the day"] }),
    ]});
    expect(r.pendingDays).toEqual([{
      date: "2026-06-27", roster: ["Андріан", "Сергій"], status: "NEEDS_REVIEW",
      reasons: ["no #datasets notice for the day"],
      amountAtStake: 2 * (TRIP + WEEKEND), // 06-27 is a Saturday
    }]);
    expect(r.total).toBe(0);
  });

  it("does not list no-fly review days as pending", () => {
    const r = computeBonuses({ period: PERIOD, losses: [], days: [
      qd({ date: "2026-06-07", status: "NEEDS_REVIEW", flew: false, roster: [] }),
    ]});
    expect(r.pendingDays).toHaveLength(0);
  });

  it("REJECTED days land in voidedDays with the verdict reason", () => {
    const r = computeBonuses({ period: PERIOD, losses: [], days: [
      qd({ date: "2026-06-30", status: "REJECTED", reasons: ["deployment 120m is under 3h"], roster: ["Влад", "Любомир"] }),
    ]});
    expect(r.voidedDays).toEqual([{ date: "2026-06-30", roster: ["Влад", "Любомир"], reason: "deployment 120m is under 3h" }]);
  });

  it("early bonus still keys off the Звіт start time", () => {
    const r = computeBonuses({ period: PERIOD, losses: [], days: [qd({ start: "07:30" })] });
    expect(r.people[0].early).toBe(1);
    expect(r.people[0].gross).toBe(TRIP + EARLY);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/fieldBonus.test.ts`
Expected: FAIL — `computeBonuses` still expects `reports`/`videoMinutesByDate`/`droneCountByDate`.

- [ ] **Step 3: Implement.** In `lib/fieldBonus.ts`: update the module doc comment (trip counts iff the day's **verdict** is ACCEPTED/ACCEPTED_EXCEPTION — the unified gate; this module is money math only). Remove `import type { FieldReport } from "./fieldReports";` and add `import type { VerdictStatus } from "./fieldDayVerdict";`. Add the `QualifiedDay`/`PendingDay` interfaces and update `DayBonus`/`BonusReport` per the Interfaces block. Replace the day loop:

```ts
  const { period, days: qualified, losses, corrections = [] } = input;
  const correctionFor = (date: string) => corrections.find((c) => c.date === date);
  const flags: Flag[] = [];
  const days: DayBonus[] = [];
  const pendingDays: PendingDay[] = [];

  for (const q of qualified) {
    for (const u of q.unknownInitials) flags.push({ kind: "unknown_initial", date: q.date, detail: u });
    const counted = q.status === "ACCEPTED" || q.status === "ACCEPTED_EXCEPTION";
    const sm = startMin(q.start);
    const earlyEligible = sm != null && sm <= EARLY_CUTOFF_MIN;
    const early = counted && earlyEligible;
    const weekend = counted && isWeekend(q.date);
    const eff = applyRosterCorrection(q.roster, counted, correctionFor(q.date));
    const reason = counted ? "counted" : q.reasons.join("; ") || q.status;
    days.push({ date: q.date, roster: eff.roster, deployMin: q.deployMin, videoMin: q.videoMin, counted, early, weekend, reason, status: q.status });
    if ((q.status === "PENDING" || q.status === "NEEDS_REVIEW") && q.flew) {
      const perPerson = TRIP + (earlyEligible ? EARLY : 0) + (isWeekend(q.date) ? WEEKEND : 0);
      pendingDays.push({ date: q.date, roster: eff.roster, status: q.status, reasons: q.reasons, amountAtStake: perPerson * eff.roster.length });
    }
  }
```

The tally / flight-group / loss-window / penalty / people / total blocks are **unchanged** (they key off `days[].counted` and rosters). Replace the `voidedDays` derivation and return:

```ts
  const voidedDays = days.filter((d) => d.status === "REJECTED").map((d) => ({ date: d.date, roster: d.roster, reason: d.reason }));
  return { period, days, people, penalties, teamZeroed, flags, total, voidedDays, pendingDays };
```

Keep the `Flag` union as-is (old committed JSON still carries `counted_no_video`/`no_drone_count`; the calculator now only emits `unknown_initial` — the verdict reasons carry the rest).

- [ ] **Step 4: Run**

Run: `npx vitest run lib/fieldBonus.test.ts && npx tsc --noEmit`
Expected: fieldBonus tests PASS; `tsc` FAILS in `lib/computeBonuses.ts` (old call shape) — that's Task 5. If `lib/bonusNotify.ts`/`lib/fieldBonusDiff.ts` fail on `DayBonus`, they shouldn't (the shape only gained `status`) — fix any strict-literal fixture in their tests by adding `status: "ACCEPTED"`.

- [ ] **Step 5: Commit**

```bash
git add lib/fieldBonus.ts lib/fieldBonus.test.ts
git commit -m "feat(bonus): pay verdict-qualified days — status filter + pendingDays, gates removed"
```

---

### Task 5: Orchestrator — `computeBonusReport` consumes `computeVerdicts`

**Files:**
- Modify: `lib/computeBonuses.ts`
- Test: `lib/computeBonuses.test.ts` (re-mock)

**Interfaces:**
- Consumes: `computeVerdicts(period, { onLog })` (returns `VerdictReport` whose `days: DayVerdict[]` carry `status/roster/unknownInitials/deployMin/videoMinutes/reasons/airborneMinutes/airborneReported`), `QualifiedDay` (Task 4).
- Produces: `computeBonusReport(period, opts)` — same signature as today (callers `scripts/field-bonus.ts:13`, `app/api/field-bonus/route.ts:43` unchanged).

- [ ] **Step 1: Update the orchestrator test.** In `lib/computeBonuses.test.ts`, replace the Vimeo/droneCount mocks with a `computeVerdicts` mock (vi.hoisted pattern, matching the file's existing mock style):

```ts
const mocks = vi.hoisted(() => ({
  computeVerdicts: vi.fn(),
  readChannelMessages: vi.fn(async () => []),
  extractLoss: vi.fn(),
}));
vi.mock("./computeVerdicts", () => ({ computeVerdicts: mocks.computeVerdicts, todayInFieldTz: () => "2026-07-03" }));
vi.mock("./slackMirror", () => ({ readChannelMessages: mocks.readChannelMessages }));
vi.mock("./lossExtract", () => ({ extractLoss: mocks.extractLoss }));
// keep the existing mocks for ./reports, ./rosterAliases, ./rosterCorrections, ./fieldRoster as they are

it("maps verdict days to qualified days and pays accepted ones", async () => {
  mocks.computeVerdicts.mockResolvedValue({ days: [
    { date: "2026-06-02", status: "ACCEPTED", roster: ["Андріан"], unknownInitials: [], deployMin: 270,
      videoMinutes: 44.8, airborneMinutes: 55, airborneReported: true, reasons: [], ratio: 0.8,
      datasetStatus: "POSTED", withinGrace: false },
    { date: "2026-06-27", status: "NEEDS_REVIEW", roster: ["Сергій"], unknownInitials: [], deployMin: 180,
      videoMinutes: 30, airborneMinutes: 7.8, airborneReported: true, reasons: ["no #datasets notice for the day"],
      ratio: 3.8, datasetStatus: "MISSING", withinGrace: false },
  ]});
  const report = await computeBonusReport({ start: "2026-06-01", end: "2026-06-30" });
  expect(report.people.map((p) => p.name)).toEqual(["Андріан"]);
  expect(report.pendingDays.map((d) => d.date)).toEqual(["2026-06-27"]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/computeBonuses.test.ts`
Expected: FAIL (orchestrator still fetches Vimeo / runs the drone gate).

- [ ] **Step 3: Implement.** Rewrite `lib/computeBonuses.ts` (doc comment: "One gate: the resolved verdict days…"):

```ts
import "server-only";
import { computeVerdicts } from "./computeVerdicts";
import { readChannelMessages } from "./slackMirror";
import { writeReport } from "./reports";
import { parseMonth } from "./fieldReports";
import { computeBonuses, roundVideoMin, type BonusReport, type LossRecord, type QualifiedDay } from "./fieldBonus";
import { extractLoss } from "./lossExtract";
import { readAliases, mergeAliases } from "./rosterAliases";
import { readRosterCorrections } from "./rosterCorrections";
import { SEED_ALIASES } from "./fieldRoster";
import { todayInFieldTz } from "./syncChannels";
import { toCsv } from "../scripts/fieldBonusReport";
import type { Period } from "./period";

export { todayInFieldTz };

export async function computeBonusReport(
  period: Period,
  opts: { write?: boolean; onLog?: (m: string) => void } = {},
): Promise<BonusReport> {
  const log = opts.onLog ?? (() => {});

  // One gate: the resolved verdict (video/deploy/drone/dataset axes + approver
  // overrides). ACCEPTED ⇔ the day pays.
  const verdicts = await computeVerdicts(period, { onLog: log });

  // The Звіт parse still supplies what the money math needs beyond the gate:
  // arrival time (early bonus) and crash text (drone losses).
  const aliases = mergeAliases(SEED_ALIASES, await readAliases());
  const messages = (await readChannelMessages("field-qa", period)).filter((m) => !m.deleted);
  const reports = parseMonth(messages, aliases);
  const parsedByDate = new Map(reports.map((r) => [r.flightDate, r]));

  const losses: LossRecord[] = [];
  for (const r of reports) {
    if (!r.crashText) continue;
    const cls = await extractLoss(r.crashText);
    if (cls.lost) losses.push({ date: r.flightDate, found: cls.found, note: cls.note });
  }
  log(`field-bonus: ${losses.filter((l) => !l.found).length} unrecovered loss(es)`);

  const corrections = await readRosterCorrections();
  const days: QualifiedDay[] = verdicts.days.map((d) => ({
    date: d.date,
    status: d.status,
    roster: d.roster,
    unknownInitials: d.unknownInitials,
    deployMin: d.deployMin ?? parsedByDate.get(d.date)?.deployMin ?? null,
    videoMin: roundVideoMin(d.videoMinutes),
    start: parsedByDate.get(d.date)?.start ?? null,
    reasons: d.reasons,
    flew: d.airborneMinutes > 0 || !d.airborneReported,
  }));
  const report = computeBonuses({ period, days, losses, corrections });
  log(`field-bonus: ${report.days.filter((x) => x.counted).length} counted day(s), ${report.pendingDays.length} pending, ${report.voidedDays.length} voided`);

  if (opts.write) {
    const { key } = await writeReport("field-bonus", period, { json: JSON.stringify(report), csv: toCsv(report) });
    log(`field-bonus: wrote report for ${key}`);
  }
  return report;
}
```

(Gone: `fetchVideosInPeriod`, `videoFlightDate`, `extractDroneReports`, the `droneCountByDate` block, `MIN_DEPLOY_MIN`/`MIN_VIDEO_MIN` imports. Note `applyRosterCorrection` runs on the verdict's already-corrected roster inside the calculator — it was applied twice before this change too, and set/add/remove corrections are idempotent.)

- [ ] **Step 4: Run**

Run: `npx vitest run lib/computeBonuses.test.ts && npx tsc --noEmit`
Expected: PASS; typecheck clean repo-wide.

- [ ] **Step 5: Commit**

```bash
git add lib/computeBonuses.ts lib/computeBonuses.test.ts
git commit -m "feat(bonus): orchestrate off computeVerdicts — one gate, one Vimeo fetch"
```

---

### Task 6: Surfaces — CSV, table, web pending section

**Files:**
- Modify: `scripts/fieldBonusReport.ts` (`toCsv`, `formatTable`)
- Modify: `app/(dashboard)/field-bonus/page.tsx` (pending section after the voided block at line ~217; update the voided copy)
- Test: `scripts/fieldBonusReport.test.ts` (or the existing test file covering `toCsv`/`formatTable` — check `ls scripts/*.test.ts` / `lib/fieldBonusDiff.test.ts` first)

**Interfaces:**
- Consumes: `BonusReport.pendingDays` / `.voidedDays` (Task 4 shapes).

- [ ] **Step 1: Write failing tests** for the CSV/table additions:

```ts
const report: BonusReport = {
  period: { start: "2026-06-01", end: "2026-06-30" },
  days: [], people: [{ name: "Андріан", trips: 1, early: 0, weekend: 0, gross: 700, penaltyPct: 0, net: 700 }],
  penalties: [], teamZeroed: false, flags: [], total: 700,
  voidedDays: [{ date: "2026-06-30", roster: ["Влад", "Любомир"], reason: "deployment 120m is under 3h" }],
  pendingDays: [{ date: "2026-06-27", roster: ["Андріан", "Сергій"], status: "NEEDS_REVIEW", reasons: ["no #datasets notice for the day"], amountAtStake: 2000 }],
};

it("toCsv appends a pending section", () => {
  const csv = toCsv(report);
  expect(csv).toContain("pending,date,status,roster,amountAtStake");
  expect(csv).toContain('pending,2026-06-27,NEEDS_REVIEW,"Андріан, Сергій",2000');
});

it("formatTable prints pending and voided days", () => {
  const t = formatTable(report);
  expect(t).toContain("Pending review:");
  expect(t).toContain("2026-06-27  NEEDS_REVIEW  Андріан, Сергій — ₴2000 at stake");
  expect(t).toContain("Voided (rejected):");
  expect(t).toContain("2026-06-30  Влад, Любомир — deployment 120m is under 3h");
});
```

- [ ] **Step 2: Run to verify failure**, then **implement**:

```ts
export function toCsv(report: BonusReport): string {
  const head = "person,trips,early,weekend,gross,penaltyPct,net";
  const rows = report.people.map((p) => [p.name, p.trips, p.early, p.weekend, p.gross, p.penaltyPct, p.net].join(","));
  const lines = [head, ...rows];
  if (report.pendingDays.length) {
    lines.push("", "pending,date,status,roster,amountAtStake");
    for (const d of report.pendingDays) lines.push(`pending,${d.date},${d.status},"${d.roster.join(", ")}",${d.amountAtStake}`);
  }
  return lines.join("\n");
}
```

`formatTable` — after the `TOTAL net=` line:

```ts
  if (report.pendingDays.length) {
    lines.push("Pending review:");
    for (const d of report.pendingDays) lines.push(`  ${d.date}  ${d.status}  ${d.roster.join(", ") || "(no crew)"} — ₴${d.amountAtStake} at stake (${d.reasons.join("; ")})`);
  }
  if (report.voidedDays.length) {
    lines.push("Voided (rejected):");
    for (const d of report.voidedDays) lines.push(`  ${d.date}  ${d.roster.join(", ") || "(no crew)"} — ${d.reason}`);
  }
```

(Adjust the test's expected strings to these exact templates.)

Web page — insert after the voided-days block (`page.tsx:217`), same visual pattern (slate/amber cards exist above):

```tsx
          {/* Pending-review days (unsettled — not in the total) */}
          {report.pendingDays && report.pendingDays.length > 0 && (
            <div className="rounded-md border border-sky-200 bg-sky-50 p-4">
              <h2 className="text-sm font-semibold text-sky-900">
                Pending review — not paid yet ({report.pendingDays.length})
              </h2>
              <p className="mt-1 text-xs text-sky-700">
                These flight days are not settled (PENDING / NEEDS_REVIEW); the amounts join the
                total only after an approver accepts the day.
              </p>
              <ul className="mt-2 space-y-1 text-sm text-sky-900">
                {report.pendingDays.map((d) => (
                  <li key={d.date} className="tabular-nums">
                    {d.date} — {d.roster.join(", ") || "(no crew parsed)"} — ₴{d.amountAtStake.toLocaleString("uk-UA")} at stake
                    <span className="text-xs text-sky-600"> ({d.reasons.join("; ")})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
```

Also update the voided-days card copy (`page.tsx:203-208`): heading `Voided days — rejected by the qualification gate ({report.voidedDays.length})`, body text `A rejected day pays nothing for the whole crew. Reasons come from the unified verdict gate (deploy ≥ 3h, video, drone-count report, dataset).`, and render `{d.date} — {d.roster.join(", ") || "(no crew parsed)"} — {d.reason}`.

The page's `BonusReport` type import comes from `lib/fieldBonus` — no local type edits needed.

- [ ] **Step 3: Run**

Run: `npx vitest run scripts/ lib/fieldBonusDiff.test.ts lib/bonusNotify.test.ts && npm run lint && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/fieldBonusReport.ts scripts/*.test.ts "app/(dashboard)/field-bonus/page.tsx"
git commit -m "feat(bonus): pending-review section on CSV/table/web — unsettled days visible, not paid"
```

---

### Task 7: Docs + June end-to-end verification

**Files:**
- Modify: `CLAUDE.md` (the `field-verdict` and `field-bonus` bullets)
- Modify: `.claude/skills/field-bonus/SKILL.md`, `.claude/skills/bonus-report/SKILL.md`

**Steps:**

- [ ] **Step 1: CLAUDE.md.** In the `field-verdict` bullet, after "…human exceptions from `reports/resolutions/store.json`", insert: `The verdict is the **unified qualification gate** (ACCEPTED ⇔ the crew is paid): deploy ≥ 3h + video ≥ max(2 хв, 50% of airborne) + a #field-qa drone-count report + a dataset notice. An admin-declined dataset, a sub-3h deployment, and a missing drone-count report are machine auto-REJECTs (hard no-pay; an approver instruction can override).` In the `field-bonus` bullet, replace the sentence "A day counts only if deploy ≥ 3h AND video ≥ 2min AND a drone-count/production report was posted…" with: `A day pays iff its field-verdict is ACCEPTED / ACCEPTED_EXCEPTION (the unified gate above — computed in-process, so run slack-sync + field-qa --write first); PENDING/NEEDS_REVIEW days are listed unpaid in pendingDays, REJECTED days in voidedDays.`

- [ ] **Step 2: Skills.** In `.claude/skills/field-bonus/SKILL.md` "Domain (must-know)": replace the first bullet (trip gate) with `A **trip counts** iff the day's field-verdict status is ACCEPTED or ACCEPTED_EXCEPTION — the unified gate: deployment ≥ **3 hours**, video ≥ max(**2 minutes**, 50% of airborne), a **drone-count report** in #field-qa, and a **dataset notice**. «Прийнято» in Slack ⇔ the crew is paid. Unsettled days sit in \`pendingDays\` (not paid); REJECTED days in \`voidedDays\`.` In `.claude/skills/bonus-report/SKILL.md` "Gate (must-know)": rewrite the numbered list to the four axes + the settled-only rule, and note that a missing drone report or sub-3h deploy is a hard machine REJECT (only an explicit approver override rescues it — don't propose other rescues). Add `pendingDays[]` to the "How to read it" list: `unsettled days with the amount at stake — chase these before month-end payout`.

- [ ] **Step 3: June verification (no publishes).** Run:

```bash
npm run field-qa -- --start 2026-06-01 --end 2026-06-30 --write   # refresh droneReport days
npm run --silent field-verdict -- --start 2026-06-01 --end 2026-06-30 --format table
npm run --silent field-bonus  -- --start 2026-06-01 --end 2026-06-30 --format table
```

Expected against spec §6: 06-30 ⛔ REJECTED (виїзд < 3 год); 06-03 and 06-16 NEEDS_REVIEW; 06-26 + 06-27 in `Pending review:` (₴1400 + ₴2000); Андріан+Сергій gain 06-21 (ACCEPTED_EXCEPTION, Sunday); `TOTAL net=19100`. Any mismatch → **stop and report the divergence** (do not force-fit); the daily data may have moved since the spec snapshot — recheck against the live verdict table before assuming a bug.

- [ ] **Step 4: Full suite + commit**

```bash
npx vitest run && npm run lint && npx tsc --noEmit
git add CLAUDE.md .claude/skills/field-bonus/SKILL.md .claude/skills/bonus-report/SKILL.md
git commit -m "docs: unified gate — ACCEPTED ⇔ pays (CLAUDE.md + bonus skills)"
```

**Explicitly NOT in this plan** (operator-gated, run only when the user says so): `field-verdict --write` for June, `field-bonus --write`, and `field-backfill -- --publish` to amend the published 06-30/06-01-class messages.
