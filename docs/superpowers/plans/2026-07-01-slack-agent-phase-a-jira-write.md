# Slack Conversational Agent — Phase A Implementation Plan (Jira write client + people routing)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Jira *write* client (create / update / transition / comment / search) plus a pure people→project routing module that encodes Bohdan's Mr-Lab rule, and a deterministic DRY-RUN-by-default CLI to exercise them — all without any LLM or Slack code.

**Architecture:** Extend the existing `server-only` `lib/jira.ts` with write functions that reuse its `config()`/`authHeader()` and add a minimal plain-text→ADF converter (Jira Cloud v3 requires ADF, not strings). A new pure `lib/jiraRouting.ts` maps a `Person` to `{ projectKey, assignInDescription, jiraAccountId }`. A new `scripts/jira-write.ts` CLI resolves a person, computes the routing, and prints the resolved create-plan (DRY-RUN); `--yes` performs the create. Phase B's agent loop will later call the same `lib/` functions.

**Tech Stack:** TypeScript (strict), Next.js 16 repo conventions, Vitest (with the `server-only`→`empty.js` alias), `node --conditions=react-server --import tsx` for CLIs, Jira Cloud REST API v3.

## Global Constraints

- `lib/jira.ts` keeps `import "server-only";` — never remove it; never import it from a `"use client"` file. CLIs/tests reach it only via `--conditions=react-server` / the vitest alias.
- `lib/jiraRouting.ts` MUST be pure (no `server-only`, no `node:*`, no Next imports) — it is a literal-config + pure-function module like `lib/people.ts`.
- TypeScript `strict` is on. No `any` in exported signatures.
- Writes are **DRY-RUN by default** in the CLI; a real Jira write requires the explicit `--yes` flag (house pattern, mirrors `field-publish`).
- Jira Cloud v3 create/comment bodies use **ADF** (Atlassian Document Format), not plain strings.
- Frequent commits: one per task.
- Two config values are operator-supplied via env (`JIRA_DEFAULT_PROJECT`, `JIRA_MRLAB_PROJECT`); tests inject config explicitly so logic is fully covered without them.

---

### Task 1: People→project routing (`lib/jiraRouting.ts`)

Encodes Bohdan's rule: Любомир / Андріан / Тарас → the **Mr Lab** project with the assignee written into the description; everyone else → the default project. Because `lib/people.ts` stores Jira *display names / usernames* (e.g. `"taras.panasyuk"`, `"Andrii"`), **not** the `accountId` Jira's `assignee` field requires, we add an optional `jiraAccountId` to `Person` and only set a real assignee when it is present; otherwise the person goes into the description too. In v1 no person has a `jiraAccountId`, so every ticket names the person in the description — which is exactly Bohdan's Mr-Lab behavior and strictly safe for the rest.

**Files:**
- Modify: `lib/people.ts` (add optional `jiraAccountId?: string` to the `Person` interface)
- Create: `lib/jiraRouting.ts`
- Test: `lib/jiraRouting.test.ts`

**Interfaces:**
- Consumes: `Person` from `lib/people.ts`.
- Produces:
  - `interface RoutingConfig { defaultProject: string; mrLabProject: string; mrLabPeople: string[] }`
  - `const MRLAB_PEOPLE: string[]` — canonical names `["Liubomyr Zaiats", "Andrian Korchynskiy", "Taras Panasyuk"]`
  - `function routingConfigFromEnv(): RoutingConfig` — reads `JIRA_DEFAULT_PROJECT`, `JIRA_MRLAB_PROJECT`; throws if either missing; `mrLabPeople` defaults to `MRLAB_PEOPLE`.
  - `interface IssueRouting { projectKey: string; assignInDescription: boolean; jiraAccountId: string | null }`
  - `function routeIssue(person: Person, cfg: RoutingConfig): IssueRouting`

- [ ] **Step 1: Add `jiraAccountId` to the `Person` interface**

In `lib/people.ts`, extend the interface (leave `PEOPLE` entries unchanged — the field is optional and unset for now):

```ts
export interface Person {
  /** Canonical display name (NOT the Cyrillic roster name). */
  name: string;
  role: string;
  slackId?: string;
  jiraAccount?: string;
  /** Jira Cloud accountId (required to set a real assignee). Distinct from
   *  jiraAccount, which is only a display name/username. Unset for now. */
  jiraAccountId?: string;
  githubLogin?: string;
  rosterInitial?: string;
}
```

- [ ] **Step 2: Write the failing test**

Create `lib/jiraRouting.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { routeIssue, type RoutingConfig } from "./jiraRouting";
import type { Person } from "./people";

const CFG: RoutingConfig = {
  defaultProject: "OPS",
  mrLabProject: "MRLAB",
  mrLabPeople: ["Liubomyr Zaiats", "Andrian Korchynskiy", "Taras Panasyuk"],
};

const p = (over: Partial<Person>): Person => ({ name: "X", role: "developer", ...over });

describe("routeIssue", () => {
  it("routes an Mr-Lab person to the Mr-Lab project, assignee in description", () => {
    const r = routeIssue(p({ name: "Taras Panasyuk", jiraAccount: "taras.panasyuk" }), CFG);
    expect(r).toEqual({ projectKey: "MRLAB", assignInDescription: true, jiraAccountId: null });
  });

  it("routes a non-Mr-Lab person with no accountId to the default project, in description", () => {
    const r = routeIssue(p({ name: "Denys Borysov", jiraAccount: "denys.borysov" }), CFG);
    expect(r).toEqual({ projectKey: "OPS", assignInDescription: true, jiraAccountId: null });
  });

  it("sets a real assignee for a non-Mr-Lab person who has an accountId", () => {
    const r = routeIssue(p({ name: "Denys Borysov", jiraAccountId: "acc-123" }), CFG);
    expect(r).toEqual({ projectKey: "OPS", assignInDescription: false, jiraAccountId: "acc-123" });
  });

  it("keeps an Mr-Lab person in the description even if they have an accountId", () => {
    const r = routeIssue(p({ name: "Liubomyr Zaiats", jiraAccountId: "acc-9" }), CFG);
    expect(r).toEqual({ projectKey: "MRLAB", assignInDescription: true, jiraAccountId: null });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run lib/jiraRouting.test.ts`
Expected: FAIL — `Cannot find module './jiraRouting'`.

- [ ] **Step 4: Implement `lib/jiraRouting.ts`**

```ts
/**
 * Pure people→project routing for Jira ticket creation. No server-only / node
 * imports — a literal-config + pure-function module like lib/people.ts.
 *
 * Encodes the Head-of-Engineering rule: Любомир / Андріан / Тарас are created on
 * the Mr Lab project with the intended assignee written into the description
 * (they are not real assignees on that board). Everyone else goes to the default
 * project; a real Jira assignee is set only when the person carries a
 * jiraAccountId (Jira's assignee field needs an accountId, which lib/people.ts's
 * jiraAccount display-name/username is NOT). Absent that, the person is named in
 * the description — safe and unambiguous.
 */
import type { Person } from "./people";

export interface RoutingConfig {
  defaultProject: string;
  mrLabProject: string;
  mrLabPeople: string[];
}

/** Canonical lib/people.ts names that route to Mr Lab (Bohdan's rule). */
export const MRLAB_PEOPLE: string[] = [
  "Liubomyr Zaiats",
  "Andrian Korchynskiy",
  "Taras Panasyuk",
];

export function routingConfigFromEnv(): RoutingConfig {
  const defaultProject = process.env.JIRA_DEFAULT_PROJECT;
  const mrLabProject = process.env.JIRA_MRLAB_PROJECT;
  if (!defaultProject) throw new Error("JIRA_DEFAULT_PROJECT is not set on the server.");
  if (!mrLabProject) throw new Error("JIRA_MRLAB_PROJECT is not set on the server.");
  return { defaultProject, mrLabProject, mrLabPeople: MRLAB_PEOPLE };
}

export interface IssueRouting {
  projectKey: string;
  assignInDescription: boolean;
  jiraAccountId: string | null;
}

export function routeIssue(person: Person, cfg: RoutingConfig): IssueRouting {
  const isMrLab = cfg.mrLabPeople.includes(person.name);
  if (isMrLab) {
    return { projectKey: cfg.mrLabProject, assignInDescription: true, jiraAccountId: null };
  }
  if (person.jiraAccountId) {
    return { projectKey: cfg.defaultProject, assignInDescription: false, jiraAccountId: person.jiraAccountId };
  }
  return { projectKey: cfg.defaultProject, assignInDescription: true, jiraAccountId: null };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run lib/jiraRouting.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/jiraRouting.ts lib/jiraRouting.test.ts lib/people.ts
git commit -m "feat(jira): people→project routing (Mr-Lab rule) for ticket creation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Jira write client (`lib/jira.ts` additions)

Add the plain-text→ADF converter and the write/search functions to the existing `server-only` `lib/jira.ts`, reusing its `config()` and `authHeader()`. All calls are live (`cache: "no-store"`) and map non-2xx to `JiraError` exactly like `fetchResolvedIssues`.

**Files:**
- Modify: `lib/jira.ts` (append new exports; do not touch `fetchResolvedIssues`)
- Test: `lib/jiraWrite.test.ts`

**Interfaces:**
- Consumes: `config()`, `authHeader()`, `JiraError` (already in `lib/jira.ts`).
- Produces:
  - `function textToAdf(text: string): object` — minimal ADF doc; blank lines split paragraphs.
  - `interface CreateIssueInput { projectKey: string; summary: string; description: string; issueType?: string; assigneeAccountId?: string | null }`
  - `interface CreatedIssue { key: string; url: string }`
  - `function createIssue(input: CreateIssueInput): Promise<CreatedIssue>` — POST `/rest/api/3/issue`; `issueType` defaults to `"Task"`; `url` is `${baseUrl}/browse/${key}`.
  - `function addComment(key: string, body: string): Promise<void>` — POST `/rest/api/3/issue/{key}/comment`.
  - `function updateIssue(key: string, fields: Record<string, unknown>): Promise<void>` — PUT `/rest/api/3/issue/{key}` with `{ fields }`.
  - `function transitionIssue(key: string, transitionId: string): Promise<void>` — POST `/rest/api/3/issue/{key}/transitions` with `{ transition: { id } }`.
  - `function searchIssues(jql: string, max?: number): Promise<{ key: string; summary: string; status: string }[]>` — GET `/rest/api/3/search/jql`.

- [ ] **Step 1: Write the failing test**

Create `lib/jiraWrite.test.ts` (sets the env `config()` requires, and mocks `fetch`):

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { textToAdf, createIssue, addComment, searchIssues } from "./jira";

const ENV = {
  JIRA_BASE_URL: "https://ex.atlassian.net",
  JIRA_EMAIL: "bot@ex.com",
  JIRA_API_TOKEN: "tok",
  JIRA_PROJECT_KEYS: "OPS",
  JIRA_STORY_POINTS_FIELD: "customfield_10016",
};

beforeEach(() => {
  Object.assign(process.env, ENV);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(status: number, json: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(json), { status }),
  );
}

describe("textToAdf", () => {
  it("wraps text as a one-paragraph ADF doc", () => {
    expect(textToAdf("hello")).toEqual({
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
    });
  });
  it("splits blank-line-separated paragraphs", () => {
    const doc = textToAdf("a\n\nb") as { content: unknown[] };
    expect(doc.content).toHaveLength(2);
  });
});

describe("createIssue", () => {
  it("POSTs to /rest/api/3/issue and returns key + browse url", async () => {
    const f = mockFetch(201, { key: "OPS-42" });
    const out = await createIssue({ projectKey: "OPS", summary: "S", description: "D" });
    expect(out).toEqual({ key: "OPS-42", url: "https://ex.atlassian.net/browse/OPS-42" });
    const [url, opts] = f.mock.calls[0];
    expect(url).toBe("https://ex.atlassian.net/rest/api/3/issue");
    expect(opts?.method).toBe("POST");
    const body = JSON.parse(String(opts?.body));
    expect(body.fields.project).toEqual({ key: "OPS" });
    expect(body.fields.summary).toBe("S");
    expect(body.fields.issuetype).toEqual({ name: "Task" });
    expect(body.fields.description.type).toBe("doc");
    expect("assignee" in body.fields).toBe(false);
  });

  it("sets assignee when accountId given", async () => {
    const f = mockFetch(201, { key: "OPS-1" });
    await createIssue({ projectKey: "OPS", summary: "S", description: "D", assigneeAccountId: "acc-9" });
    const body = JSON.parse(String(f.mock.calls[0][1]?.body));
    expect(body.fields.assignee).toEqual({ accountId: "acc-9" });
  });

  it("throws JiraError on non-2xx", async () => {
    mockFetch(400, { errorMessages: ["bad"] });
    await expect(createIssue({ projectKey: "OPS", summary: "S", description: "D" })).rejects.toThrow(
      /Jira API returned 400/,
    );
  });
});

describe("searchIssues", () => {
  it("GETs /rest/api/3/search/jql and maps rows", async () => {
    mockFetch(200, {
      issues: [{ key: "OPS-7", fields: { summary: "Fix", status: { name: "To Do" } } }],
      isLast: true,
    });
    const rows = await searchIssues("project = OPS", 10);
    expect(rows).toEqual([{ key: "OPS-7", summary: "Fix", status: "To Do" }]);
  });
});

describe("addComment", () => {
  it("POSTs an ADF comment body", async () => {
    const f = mockFetch(201, {});
    await addComment("OPS-3", "note");
    const [url, opts] = f.mock.calls[0];
    expect(url).toBe("https://ex.atlassian.net/rest/api/3/issue/OPS-3/comment");
    const body = JSON.parse(String(opts?.body));
    expect(body.body.type).toBe("doc");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/jiraWrite.test.ts`
Expected: FAIL — `textToAdf`/`createIssue` not exported.

- [ ] **Step 3: Implement the additions in `lib/jira.ts`**

Append to `lib/jira.ts` (after `fetchResolvedIssues`). Reuses the existing `config()`, `authHeader()`, `JiraError`, `API_VERSION`:

```ts
const CONTENT_TYPE = "application/json";

/** Minimal plain-text → Atlassian Document Format. Blank lines split paragraphs.
 *  Jira Cloud v3 requires ADF for description/comment bodies (plain strings 400). */
export function textToAdf(text: string): object {
  const paras = text.split(/\n\s*\n/).map((p) => p.replace(/\n/g, " ").trim());
  const content = (paras.length ? paras : [""]).map((p) => ({
    type: "paragraph",
    content: p ? [{ type: "text", text: p }] : [],
  }));
  return { type: "doc", version: 1, content };
}

async function jiraWrite(
  path: string,
  method: "POST" | "PUT",
  body: unknown,
): Promise<unknown> {
  const cfg = config();
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: {
      Accept: API_VERSION,
      "Content-Type": CONTENT_TYPE,
      Authorization: authHeader(cfg),
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new JiraError(
      `Jira API returned ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ""}`,
      res.status,
    );
  }
  const raw = await res.text();
  return raw ? JSON.parse(raw) : {};
}

export interface CreateIssueInput {
  projectKey: string;
  summary: string;
  description: string;
  issueType?: string;
  assigneeAccountId?: string | null;
}
export interface CreatedIssue {
  key: string;
  url: string;
}

export async function createIssue(input: CreateIssueInput): Promise<CreatedIssue> {
  const fields: Record<string, unknown> = {
    project: { key: input.projectKey },
    summary: input.summary,
    issuetype: { name: input.issueType ?? "Task" },
    description: textToAdf(input.description),
  };
  if (input.assigneeAccountId) fields.assignee = { accountId: input.assigneeAccountId };
  const out = (await jiraWrite("/rest/api/3/issue", "POST", { fields })) as { key: string };
  return { key: out.key, url: `${config().baseUrl}/browse/${out.key}` };
}

export async function addComment(key: string, body: string): Promise<void> {
  await jiraWrite(`/rest/api/3/issue/${key}/comment`, "POST", { body: textToAdf(body) });
}

export async function updateIssue(key: string, fields: Record<string, unknown>): Promise<void> {
  await jiraWrite(`/rest/api/3/issue/${key}`, "PUT", { fields });
}

export async function transitionIssue(key: string, transitionId: string): Promise<void> {
  await jiraWrite(`/rest/api/3/issue/${key}/transitions`, "POST", {
    transition: { id: transitionId },
  });
}

export interface SearchRow {
  key: string;
  summary: string;
  status: string;
}

export async function searchIssues(jql: string, max = 20): Promise<SearchRow[]> {
  const cfg = config();
  const params = new URLSearchParams({
    jql,
    maxResults: String(max),
    fields: ["summary", "status"].join(","),
  });
  const url = `${cfg.baseUrl}/rest/api/3/search/jql?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Accept: API_VERSION, Authorization: authHeader(cfg) },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new JiraError(
      `Jira API returned ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ""}`,
      res.status,
    );
  }
  const page = (await res.json()) as {
    issues?: { key: string; fields?: { summary?: string; status?: { name?: string } } }[];
  };
  return (page.issues ?? []).map((i) => ({
    key: i.key,
    summary: i.fields?.summary ?? "",
    status: i.fields?.status?.name ?? "",
  }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/jiraWrite.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Confirm the full suite and lint still pass**

Run: `npm test && npm run lint`
Expected: no failures; no new lint errors in `lib/jira.ts` / `lib/jiraWrite.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add lib/jira.ts lib/jiraWrite.test.ts
git commit -m "feat(jira): write client — create/update/transition/comment/search + ADF

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: DRY-RUN-by-default create CLI (`scripts/jira-write.ts`)

A deterministic CLI (no LLM) that resolves a person, computes routing, prints the resolved create-plan, and — only with `--yes` — creates the ticket. This is Phase A's testable second interface and the harness Phase B's agent loop will reuse under the hood.

**Files:**
- Create: `scripts/jira-write.ts`
- Modify: `package.json` (add the `jira-write` script)
- Modify: `CLAUDE.md` (document the command)

**Interfaces:**
- Consumes: `personByQuery` (`lib/people.ts`), `routeIssue` + `routingConfigFromEnv` (`lib/jiraRouting.ts`), `createIssue` (`lib/jira.ts`).
- Produces: the `npm run jira-write` command. No new exported types.

- [ ] **Step 1: Add the npm script**

In `package.json` `scripts`, after the `jira` line, add:

```json
    "jira-write": "node --conditions=react-server --import tsx scripts/jira-write.ts",
```

- [ ] **Step 2: Implement `scripts/jira-write.ts`**

```ts
/**
 * CLI: create a Jira ticket for a person, applying the Mr-Lab routing rule.
 *
 * Usage:
 *   npm run jira-write -- create --for "<person>" --summary "<text>" [--desc "<text>"] [--yes]
 *
 * DRY-RUN by default: prints the resolved plan (project, whether the person is
 * named in the description vs assigned, summary, description) and exits without
 * touching Jira. `--yes` performs the create and prints the issue key + URL.
 *
 * Runs only under Node with `--conditions=react-server` (see package.json) so the
 * `server-only` import in ../lib/jira resolves to its empty module. Needs
 * JIRA_* env incl. JIRA_DEFAULT_PROJECT + JIRA_MRLAB_PROJECT.
 */
import { personByQuery } from "../lib/people";
import { routeIssue, routingConfigFromEnv } from "../lib/jiraRouting";
import { createIssue } from "../lib/jira";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd !== "create") {
    console.error('Usage: npm run jira-write -- create --for "<person>" --summary "<text>" [--desc "<text>"] [--yes]');
    process.exit(1);
  }
  const forQuery = flag("for");
  const summary = flag("summary");
  const desc = flag("desc") ?? "";
  if (!forQuery || !summary) {
    console.error("Both --for and --summary are required.");
    process.exit(1);
  }

  const resolved = personByQuery(forQuery);
  if ("unknown" in resolved) {
    console.error(`Unknown person: ${forQuery}`);
    process.exit(1);
  }
  if ("ambiguous" in resolved) {
    console.error(`Ambiguous "${forQuery}": ${resolved.ambiguous.map((p) => p.name).join(", ")}`);
    process.exit(1);
  }
  const person = resolved.person;

  const routing = routeIssue(person, routingConfigFromEnv());
  const description = routing.assignInDescription
    ? `Виконавець: ${person.name}\n\n${desc}`.trim()
    : desc;

  const plan = {
    project: routing.projectKey,
    assignee: routing.jiraAccountId ?? `(in description) ${person.name}`,
    summary,
    description,
  };

  if (!has("yes")) {
    console.log("DRY-RUN — would create:");
    console.log(JSON.stringify(plan, null, 2));
    console.log("Re-run with --yes to create.");
    return;
  }

  const created = await createIssue({
    projectKey: routing.projectKey,
    summary,
    description,
    assigneeAccountId: routing.jiraAccountId,
  });
  console.log(JSON.stringify(created, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
```

- [ ] **Step 3: Verify the DRY-RUN path (no Jira call)**

Run:
```bash
JIRA_BASE_URL=https://ex.atlassian.net JIRA_EMAIL=b@ex.com JIRA_API_TOKEN=t \
JIRA_PROJECT_KEYS=OPS JIRA_STORY_POINTS_FIELD=customfield_10016 \
JIRA_DEFAULT_PROJECT=OPS JIRA_MRLAB_PROJECT=MRLAB \
npm run jira-write -- create --for "Taras" --summary "Fix export" --desc "broken CSV"
```
Expected: prints a DRY-RUN plan with `"project": "MRLAB"` and `"assignee": "(in description) Taras Panasyuk"`, and does NOT hit the network. (Confirms routing + description composition end-to-end.)

- [ ] **Step 4: Document the command in `CLAUDE.md`**

Add under `## Commands` (after the `npm run jira` bullet):

```markdown
- `npm run jira-write -- create --for "<person>" --summary "<text>" [--desc "<text>"] [--yes]` — create a Jira ticket for a person, applying the Mr-Lab routing rule (`lib/jiraRouting.ts`): Любомир/Андріан/Тарас → the Mr Lab project with the assignee named in the description; everyone else → the default project (real assignee only when the person has a `jiraAccountId`). **DRY-RUN by default** (prints the resolved plan, touches nothing); `--yes` creates it and prints the key + URL. Needs `JIRA_*` env incl. `JIRA_DEFAULT_PROJECT` + `JIRA_MRLAB_PROJECT`. Deterministic (no LLM); the conversational agent (Phase B) reuses the same `lib/jira.ts` write client. (Phase A of the Slack conversational agent — see `docs/superpowers/specs/2026-07-01-slack-conversational-agent-design.md`.)
```

- [ ] **Step 5: Commit**

```bash
git add scripts/jira-write.ts package.json CLAUDE.md
git commit -m "feat(jira): jira-write CLI (DRY-RUN by default) with Mr-Lab routing

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (Phase A scope only):**
- Jira write client (create/update/transition/comment/search) → Task 2. ✓
- `lib/jiraRouting.ts` pure + Mr-Lab rule (Любомир/Андріан/Тарас → Mr Lab, assignee-in-description) → Task 1. ✓
- Routing data on `lib/people.ts` → Task 1 (`jiraAccountId` field + `MRLAB_PEOPLE` by canonical name). ✓
- CLI second interface, DRY-RUN default → Task 3. ✓
- Server-only discipline / pure-lib / vitest alias / `--conditions=react-server` → Global Constraints + tasks. ✓
- ADF requirement → Task 2 (`textToAdf`). ✓
- (Deferred to Phase B/C, correctly out of this plan: the agent loop, tool registry, Slack ingress, confirm-first proposals, web Assistant tab.)

**Placeholder scan:** No TBD/TODO; every code step shows complete code; the two operator config values are env-injected with real names and covered by injected-config tests. ✓

**Type consistency:** `routeIssue`/`RoutingConfig`/`IssueRouting` names match across Task 1 and Task 3; `createIssue`/`CreateIssueInput`/`CreatedIssue`/`searchIssues`/`textToAdf` match across Task 2 and its test and Task 3. `Person.jiraAccountId` added in Task 1 is consumed in Task 1's `routeIssue`. ✓

## Open items (carried from the spec; operator input)

- Set `JIRA_DEFAULT_PROJECT` (default project key) and `JIRA_MRLAB_PROJECT` (the "Mr Lab" project key) in `.env` / Vercel before a real `--yes` create.
- Later data task: populate `Person.jiraAccountId` for non-Mr-Lab developers to enable real Jira assignees (until then they are named in the description — safe).
