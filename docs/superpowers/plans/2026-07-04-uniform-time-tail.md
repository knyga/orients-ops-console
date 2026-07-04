# Uniform Time Tail on Verdict Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every published field-verdict Slack message carries the same facts tail — «(виїзд …; у повітрі …; відео …; датасет …)» — regardless of status, then the live June/July messages are re-edited to match.

**Architecture:** One new pure helper `formatTimeTail(day)` (plus `formatDuration(min)`) in `lib/verdictPublish.ts`, consumed by all four status branches of `formatDayMessage`. No data-model, region-parsing, or CLI changes — `field-publish`/`field-backfill` pick the new render up automatically. Spec: `docs/superpowers/specs/2026-07-04-uniform-time-tail-verdict-messages-design.md`.

**Tech Stack:** TypeScript (strict), Vitest.

## Global Constraints

- All team-facing Slack text is Ukrainian; English `day.reasons` never leak to the channel.
- `lib/verdictPublish.ts` stays pure (no imports beyond types + pure helpers) and unit-tested.
- The `👥 У полі:` / `🛸 Дрони:` suffix regions and their split/parse helpers are untouched.
- The working tree has UNRELATED modified files (`lib/instructionClassify.ts`, `lib/instructionClassifyPrompt.ts`, `lib/instructionClassifyPrompt.test.ts`, `next-env.d.ts`). Never `git add -A`; stage only the files this plan names.
- Duration wording: whole hours «N год», sub-hour «M хв», mixed «N год M хв».
- Tail segment order is fixed: виїзд; у повітрі; відео; датасет.

---

### Task 1: `formatTimeTail` + uniform application in `formatDayMessage`

**Files:**
- Modify: `lib/verdictPublish.ts` (add helpers after `datasetMarker`; rewrite `formatDayMessage` body)
- Test: `lib/verdictPublish.test.ts`

**Interfaces:**
- Consumes: `DayVerdict` from `./fieldDayVerdict` (`deployWindow?: {start,end}`, `deployMin?: number|null`, `airborneMinutes: number`, `airborneReported: boolean`, `videoMinutes: number`, `ratio: number|null`, `datasetStatus`).
- Produces: `export function formatDuration(min: number): string`; `export function formatTimeTail(day: DayVerdict): string` returning the parenthesized tail e.g. `(виїзд 08:00–16:30 — 8 год 30 хв; у повітрі 45 хв; відео 30 хв — 67%; датасет ✓)`. `formatDayMessage` signature unchanged.

- [x] **Step 1: Write the failing tests**

Append to `lib/verdictPublish.test.ts` (imports: add `formatTimeTail, formatDuration` to the existing import from `./verdictPublish`):

```ts
describe("formatDuration", () => {
  it("renders minutes-only under an hour", () => expect(formatDuration(45)).toBe("45 хв"));
  it("renders whole hours without minutes", () => expect(formatDuration(240)).toBe("4 год"));
  it("renders mixed hours and minutes", () => expect(formatDuration(510)).toBe("8 год 30 хв"));
  it("rounds fractional minutes without producing 60 хв", () => expect(formatDuration(119.7)).toBe("2 год"));
});

describe("formatTimeTail", () => {
  const base = day({
    deployWindow: { start: "08:00", end: "16:30" }, deployMin: 510,
    airborneMinutes: 45, videoMinutes: 30, ratio: 30 / 45, datasetStatus: "POSTED",
  });

  it("renders all four segments in order", () => {
    expect(formatTimeTail(base)).toBe("(виїзд 08:00–16:30 — 8 год 30 хв; у повітрі 45 хв; відео 30 хв — 67%; датасет ✓)");
  });
  it("window-only when duration is unknown", () => {
    expect(formatTimeTail({ ...base, deployMin: null })).toContain("виїзд 08:00–16:30;");
  });
  it("duration-only when the window is unknown", () => {
    expect(formatTimeTail({ ...base, deployWindow: undefined, deployMin: 240 })).toContain("(виїзд 4 год;");
  });
  it("flew but no deploy info → виїзд — не вказано", () => {
    expect(formatTimeTail({ ...base, deployWindow: undefined, deployMin: undefined })).toContain("(виїзд — не вказано;");
  });
  it("reported no-fly day with no deploy info omits the виїзд segment", () => {
    const t = formatTimeTail({ ...base, deployWindow: undefined, deployMin: undefined, airborneMinutes: 0, ratio: null, airborneReported: true });
    expect(t).not.toContain("виїзд");
    expect(t).toContain("(у повітрі 0 хв;");
  });
  it("airborne unreported → у повітрі — не вказано", () => {
    const t = formatTimeTail({ ...base, airborneMinutes: 0, ratio: null, airborneReported: false });
    expect(t).toContain("у повітрі — не вказано");
    expect(t).not.toContain("у повітрі 0 хв");
  });
  it("null ratio drops the percent", () => {
    expect(formatTimeTail({ ...base, ratio: null })).toContain("відео 30 хв;");
  });
});

describe("uniform tail on every status", () => {
  const timed = (over: Partial<DayVerdict>) => day({
    deployWindow: { start: "08:00", end: "16:30" }, deployMin: 510,
    airborneMinutes: 45, videoMinutes: 30, ratio: 30 / 45, datasetStatus: "POSTED", ...over,
  });
  const TAIL = "(виїзд 08:00–16:30 — 8 год 30 хв; у повітрі 45 хв; відео 30 хв — 67%; датасет ✓)";

  it("ACCEPTED", () => {
    expect(formatDayMessage(timed({}))).toContain(`— прийнято ${TAIL}.`);
  });
  it("NEEDS_REVIEW", () => {
    expect(formatDayMessage(timed({ status: "NEEDS_REVIEW", datasetStatus: "MISSING" })))
      .toContain("(виїзд 08:00–16:30 — 8 год 30 хв; у повітрі 45 хв; відео 30 хв — 67%; без датасету).");
  });
  it("ACCEPTED_EXCEPTION", () => {
    expect(formatDayMessage(timed({ status: "ACCEPTED_EXCEPTION", reasons: ["exception (Oleksandr K): форс-мажор"] })))
      .toContain(`виняток (Oleksandr K): форс-мажор ${TAIL}.`);
  });
  it("REJECTED", () => {
    expect(formatDayMessage(timed({ status: "REJECTED", deployMin: 120, reasons: ["deployment 120m is under 3h"] })))
      .toContain("(виїзд 08:00–16:30 — 2 год; у повітрі 45 хв; відео 30 хв — 67%; датасет ✓).");
  });
});
```

- [x] **Step 2: Run the new tests to verify they fail**

Run: `npx vitest run lib/verdictPublish.test.ts`
Expected: FAIL — `formatTimeTail`/`formatDuration` are not exported.

- [x] **Step 3: Implement the helpers and rewrite `formatDayMessage`**

In `lib/verdictPublish.ts`, after `datasetMarker`, add:

```ts
/** Format minutes as «N год M хв» (whole hours «N год», sub-hour «M хв»). Pure. */
export function formatDuration(min: number): string {
  const total = Math.round(min);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} хв`;
  if (m === 0) return `${h} год`;
  return `${h} год ${m} хв`;
}

/**
 * The uniform facts tail shown on EVERY published verdict, regardless of
 * status: time in the field (виїзд), time in the air, video minutes/ratio,
 * dataset marker. States facts only — the status clause explains the why.
 * A day that flew without deploy data says «виїзд — не вказано»; a reported
 * no-fly day with no deploy data omits the виїзд segment. Pure.
 */
export function formatTimeTail(day: DayVerdict): string {
  const parts: string[] = [];
  const w = day.deployWindow;
  const dur = typeof day.deployMin === "number" ? formatDuration(day.deployMin) : null;
  const flew = day.airborneMinutes > 0 || !day.airborneReported;
  if (w && dur) parts.push(`виїзд ${w.start}–${w.end} — ${dur}`);
  else if (w) parts.push(`виїзд ${w.start}–${w.end}`);
  else if (dur) parts.push(`виїзд ${dur}`);
  else if (flew) parts.push("виїзд — не вказано");
  parts.push(day.airborneReported ? `у повітрі ${day.airborneMinutes.toFixed(0)} хв` : "у повітрі — не вказано");
  const vid = `відео ${day.videoMinutes.toFixed(0)} хв`;
  parts.push(day.ratio === null ? vid : `${vid} — ${(day.ratio * 100).toFixed(0)}%`);
  parts.push(datasetMarker(day.datasetStatus));
  return `(${parts.join("; ")})`;
}
```

Replace the body of `formatDayMessage` (keep its doc comment, updating the last
sentence to mention the uniform tail) so every branch uses the shared tail and
the old per-status `air`/`vid`/`pct`/`ds`/`tail` locals are gone:

```ts
export function formatDayMessage(day: DayVerdict): string {
  const icon = ICON[day.status] ?? "";
  const date = dateWithWeekday(day.date);
  const tail = formatTimeTail(day);

  let body: string;
  if (day.status === "REJECTED") {
    // A human rejection (applyResolution appends `rejected[(by)]: note` last)
    // must surface its note verbatim — machine gaps alone can be empty then.
    const last = day.reasons[day.reasons.length - 1] ?? "";
    const note = /^rejected/.test(last) ? last.replace(/^rejected/, "відхилено") : "";
    const parts = [...ukrainianGaps(day), note].filter(Boolean);
    body = `⛔ ${date} — відхилено: ${parts.join("; ")} ${tail}.`;
  } else if (day.status === "ACCEPTED") {
    body = `✅ ${date} — прийнято ${tail}.`;
  } else if (day.status === "ACCEPTED_EXCEPTION") {
    // Machine gaps are rebuilt in Ukrainian (the English strings in day.reasons
    // never reach the channel). The human exception note is the LAST reason
    // (applyResolution appends `exception[(by)]: note` last); keep its text
    // verbatim, translating only the `exception` label → `виняток`.
    const note = day.reasons.length
      ? day.reasons[day.reasons.length - 1].replace(/^exception/, "виняток")
      : "";
    const parts = [...ukrainianGaps(day), note].filter(Boolean);
    body = `🟡 ${date} — прийнято (виняток): ${parts.join("; ")} ${tail}.`;
  } else {
    // NEEDS_REVIEW — rebuild the gaps in Ukrainian from the structured fields.
    body = `${icon} ${date} — потрібна перевірка: ${ukrainianGaps(day).join("; ")} ${tail}.`;
  }
  return withDroneRegion(withRosterSuffix(body, day.roster), day);
}
```

`ukrainianGaps` is unchanged.

- [x] **Step 4: Update the existing tests that asserted the old per-status wording**

In `lib/verdictPublish.test.ts`:

1. Test `"adds the Звіт-conflict clause + short tail when a no-fly day has a deploy window"` (~line 65): replace
   `expect(msg).not.toContain("/ 0 хв у повітрі"); // short tail — no redundant airborne clause`
   with
   ```ts
   expect(msg).toContain("(виїзд 17:00–20:00; у повітрі 0 хв;"); // uniform tail
   ```
2. Test `"NEEDS_REVIEW airborne-unknown day: …"` (~line 77): replace the two lines
   `expect(msg).not.toContain("хв у повітрі,"); // trailing parenthetical dropped the airborne clause`
   and `expect(msg).not.toContain("0 хв у повітрі");`
   with
   ```ts
   expect(msg).toContain("у повітрі — не вказано"); // uniform tail, honest about the unknown
   expect(msg).not.toContain("у повітрі 0 хв");
   ```
3. Leave every other existing test as-is; they assert prefixes/substrings the new render preserves.

- [x] **Step 5: Run the file, then the full suite**

Run: `npx vitest run lib/verdictPublish.test.ts`
Expected: PASS (all).
Run: `npm test`
Expected: PASS — if another suite asserts the old wording, update that assertion the same way (facts tail replaces the per-status tail) and re-run.

- [x] **Step 6: Lint and commit (only the two files)**

```bash
npm run lint
git add lib/verdictPublish.ts lib/verdictPublish.test.ts
git commit -m "feat(field-publish): uniform time-in-field tail on every verdict message

Every published status now renders the same facts tail —
(виїзд window — duration; у повітрі N хв; відео N хв — P%; датасет …) —
so time spent in the field is visible regardless of accepted/review/
exception/rejected. Spec: docs/superpowers/specs/2026-07-04-uniform-time-tail-verdict-messages-design.md

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 2: Verify end-to-end + backfill the live messages

**Files:**
- No source changes. Operational: DB-backed verdict reports + Slack edits via existing CLIs.

**Interfaces:**
- Consumes: `npm run field-verdict`, `npm run field-publish` (dry-run render), `npm run field-backfill` — all render through Task 1's `formatDayMessage`.
- Produces: refreshed `field-verdict` stored reports for June + July; re-edited live #field-qa messages.

- [x] **Step 1: Refresh inputs and stored verdicts (June + July)**

```bash
npm run slack-sync
npm run field-qa -- --start 2026-06-01 --end 2026-06-30 --write
npm run field-qa -- --start 2026-07-01 --end 2026-07-31 --write
npm run field-verdict -- --start 2026-06-01 --end 2026-06-30 --write
npm run field-verdict -- --start 2026-07-01 --end 2026-07-31 --write
```
Expected: each exits 0. (Needs `VIMEO_TOKEN`, `ANTHROPIC_API_KEY`, `POSTGRES_URL`, Slack env.)

- [x] **Step 2: Dry-run the current-month publisher as an end-to-end render check**

Run: `npm run field-publish -- --start 2026-07-01 --end 2026-07-31`
Expected: printed messages all carry the uniform tail; nothing posted (dry-run).

- [x] **Step 3: Dry-run the backfill over both months and review**

```bash
npm run field-backfill -- --start 2026-06-01 --end 2026-06-30
npm run field-backfill -- --start 2026-07-01 --end 2026-07-31
```
Expected: `old → new` pairs where every `new` has the uniform tail; overridden (struck) days reported as skipped. **Stop and eyeball each pair before publishing.** Days lacking deploy data must read «виїзд — не вказано», not garbage.

- [x] **Step 4: Publish the backfill edits**

```bash
npm run field-backfill -- --start 2026-06-01 --end 2026-06-30 --channel field-qa --publish
npm run field-backfill -- --start 2026-07-01 --end 2026-07-31 --channel field-qa --publish
```
Expected: each edited day logged; re-run prints nothing new (idempotent). Spot-check one edited message in Slack.

- [x] **Step 5: Record the outcome**

Run: `npm run sent -- --start 2026-07-04 --end 2026-07-04 --format table`
Expected: the `chat.update` edits appear in the outbound audit log.
