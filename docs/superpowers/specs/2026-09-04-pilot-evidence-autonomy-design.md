# Pilot evidence autonomy in verdict threads — design

**Date:** 2026-09-04
**Status:** approved design, awaiting implementation plan
**Supersedes (partially):** the S6 auto-accept in `lib/applyAnswer.ts` (a team member's free-text explanation flipping a day to `accepted_exception` without verification).

## 1. Goal

Give pilots autonomy to *prove* a flight day is valid without being able to *accept* it themselves.

Today a non-approver's reply in a published verdict thread is silently ignored; only the two `lib/approvers.ts` approvers can change anything, and an approver's question is a silent no-op. After this change any human reply in a verdict thread (or in one of the bot's own gap-question threads) is one of four things:

1. **Verifiable evidence** — the bot re-checks the systems it can read (Vimeo, #datasets) and applies the result itself.
2. **Unverifiable claim** — the bot turns it into a ready confirm-first proposal and tags both approvers.
3. **Approver instruction / confirm / cancel** — unchanged existing path.
4. **Chat** — the agent answers read-only with the verdict and thread as context.

Approvers only ever do four things: «так», «ні», an instruction with details, or ask a question.

**Decisions taken (2026-09-04):**

| Question | Decision |
|---|---|
| What is "enough" for the bot to accept alone | Verified data only. Explanations always escalate. |
| Whose replies count | Anyone in the channel. |
| Self-reported numbers (deploy window, airborne minutes) | Escalate to approvers as a proposal; never applied on a pilot's word. |
| Escalation shape | One message: summary + re-checked numbers + concrete proposal + @both approvers. Approver «так» applies. No re-pings in v1. |
| Evidence provided but re-check still fails | Reply with the shortfall to the pilot. No escalation until the pilot gives an explanation. |
| Old bot-question flow (S5/S6) | Same rule everywhere: verifiable data is re-checked, explanations escalate. |
| Chat in thread | Approvers and pilots, read-only. |

## 2. Non-goals

- Pilots accepting or rejecting a day. A pilot's «так» never settles anything.
- Auto-accepting explanations (weather, recorder failure) — that stays a human decision.
- A deploy-window override table (see §5.2; deferred).
- Re-pinging approvers about stale proposals.
- Changing the verdict gate itself (`lib/fieldDayVerdict.ts`). Verification *re-runs* the gate; it never bypasses it.

## 3. Branching: how a reply is routed

Two stages, then deterministic dispatch. The model never decides *who may do what*, only *what the text says*.

### 3.1 Stage 1 — deterministic pre-checks (code, no model)

1. **Is the thread ours?** `thread_ts` resolves to a published verdict (`findPublishedByTs`) or to a bot gap question (`findAskByTs`). Neither → ignored (as today). Bot messages and replies that lead with an @mention are already filtered upstream (mention branch).
2. **Role.** `isApprover(userId)` → `approver`; anyone else → `pilot`.
3. **Hints** extracted from the text by regex, passed to the classifier AND applied as hard rules:
   - Vimeo URLs (`vimeo.com/<id>`) → video evidence regardless of the model's label.
   - Slack permalinks into the #datasets channel → dataset evidence.
   - Time ranges (`09:00–15:40`, `9.00-15.40`) and minute figures («140 хв») → surfaced to the classifier as candidate deploy-window / airborne claims.

### 3.2 Stage 2 — one classifier call, role-narrowed schema

`lib/instructionClassifyPrompt.ts` / `lib/instructionClassify.ts` are extended (not duplicated). Input: verdict text, reply, pending-proposal echo (if any), role, hints. The **tool schema is built per role**, so an out-of-role intent cannot be returned:

| Role | Allowed intents |
|---|---|
| approver | `confirm`, `cancel`, `instruction`, `evidence`, `claim`, `chat`, `unclear` |
| pilot | `evidence`, `claim`, `chat`, `unclear` |

`confirm`/`cancel` are only in the schema when a proposal is pending (existing rule).

Definitions in the prompt:

- **evidence** — asserts data now exists in a system we can re-check. Exactly two kinds: `video` (Vimeo) and `dataset` (#datasets notice).
- **claim** — asserts something we cannot re-check: deploy window, airborne minutes, «борт знайшли», or an explanation (weather, recorder failure, «ми літали»).
- **instruction** — a directive to change data on an existing axis (approver-only).
- **chat** — a question or comment that asserts no data («що ще бракує?», «чому 40%?»).
- **unclear** — noise (an emoji, «ok»).

The output is a **struct**, not one label, because real replies mix parts («залив відео, а датасету не було, бо дощ»):

```ts
interface ThreadReplyClassification extends InstructionClassification {
  intent: "confirm" | "cancel" | "instruction" | "evidence" | "claim" | "chat" | "unclear";
  evidence?: { kind: "video" | "dataset"; links: string[] }[];
  claim?: {
    kind: "explanation" | "deploy_window" | "airborne" | "loss_found";
    deployWindow?: { start: string; end: string };
    airborneMinutes?: number;
    text: string;          // the pilot's words, verbatim-ish, for the note
  };
}
```

Deterministic backstop after the call (mirrors the existing intent coercion): an intent outside the role's allowed set → `unclear`; a pilot's `instruction`-shaped text (e.g. «прийняти день») → coerced to `claim/explanation`.

### 3.3 Stage 3 — dispatch (pure function, unit-tested)

`decideThreadReply(classification, role, pending: Proposal[]): ThreadReplyAction` — priority order within ONE reply:

1. approver + pending + `confirm`/`cancel` → **existing** confirm/cancel path.
2. approver + `instruction` → **existing** confirm-first instruction path.
3. `evidence[]` present → **verify** (§4). Runs first even when a claim is also present.
4. `claim` present AND the day is not ACCEPTED after step 3 → **escalate** (§5).
5. `intent === "chat"` and nothing above fired → **chat** (§6).
6. otherwise → silent (`unclear`, or a pilot's bare «так»).

Every wrong model label degrades to something harmless: an unnecessary re-check and a factual reply; an unnecessary proposal an approver can «ні»; an answer to a question nobody asked. Only the live recompute can flip a status.

### 3.4 Latency

Classification stays inline (one Claude call, as today). Confirm/cancel/instruction/claim are cheap and stay inline. **Verify** and **chat** need seconds to minutes: the webhook posts a placeholder («🔎 Перевіряю…» / «💬 …») in-thread and fires an internal route `POST /api/field/thread-reply` (secret `AGENT_RUN_SECRET`, `maxDuration = 300`) with the serialized action — the same fire-and-forget pattern as `/api/agent/run`. The placeholder is edited into the result.

## 4. Verification — the only path that accepts without a human

Module: `lib/evidenceVerify.ts` (server-only orchestration) + pure `lib/evidenceOutcome.ts`.

1. Incremental `#datasets` sync (as the nightly does).
2. `computeVerdicts(month, { write: true })` for the report's month — live Vimeo, committed field-qa airborne, resolutions, overrides. **No extraction re-run** (airborne is not what evidence changes).
3. `refreshPublishedDays` for that day (edits the message in place when the render changed; respects the existing approver-override skip).
4. Read the report's new status.

Outcomes (`EvidenceOutcome`):

| Outcome | Condition | Bot reply (in-thread, Ukrainian) |
|---|---|---|
| `closed` | status now `ACCEPTED` | «✅ Перевірив: відео 96 хв = 80% від 120 хв, датасет є — день прийнято. Дякую, Тарас.» (message already ✅ via refresh) |
| `still_open` | status still `NEEDS_REVIEW`/`PENDING` | «🔎 Перевірив: відео 48 хв = 40% від 120 хв у повітрі — бракує 12 хв. …cause hints…» |
| `hard_fail` | status `REJECTED` | «⛔ День відхилено (виїзд 150 хв < 3 год) — відео/датасет тут не допоможуть. Якщо є пояснення, напишіть — передам на затвердження.» |

**Cause hints** (deterministic, from the hints + live data, never model text):

- A linked Vimeo video whose name carries no date for this day → «відео `<name>` без дати в назві — перейменуйте, щоб воно зарахувалося за DD.MM».
- A linked Vimeo video dated another day → «відео датоване DD.MM, не цим днем».
- A #datasets permalink whose message resolves to another date → «повідомлення в #datasets датоване іншим днем».
- Vimeo attribution is by the date in the video name (`lib/computeVerdicts`); the hint text must say so explicitly or pilots loop.

A `still_open` outcome never escalates by itself. If the same reply also carried a claim, escalation follows (§3.3 step 4).

## 5. Escalation and the approver flow

### 5.1 Proposal row

Reuse the `proposals` table + `lib/proposals.ts` state machine. New column **`origin`** (`'approver' | 'pilot'`, default `'approver'` for existing rows). `proposedBy` holds the pilot's roster name (or Slack display name if not in `lib/people.ts`). Supersede rule unchanged (same thread + same axis).

Every unverifiable claim maps onto an **existing** axis — no new override tables in v1:

| Claim kind | Axis | Payload |
|---|---|---|
| `explanation` | `day` | `decision: "accepted_exception"`, `reason: <pilot's words>` |
| `deploy_window` | `day` | `decision: "accepted_exception"`, `reason: "за словами <name>: виїзд 09:00–15:40"` |
| `airborne` | `airborne` | `airborneMinutes` |
| `loss_found` | `loss` | `lossState: "found"` |

### 5.2 Deferred: deploy-window override

A proper `deploy` axis (a `deploy_overrides` table overlaying the Звіт window in `computeVerdicts`, so the gate itself passes instead of an exception) is **out of scope for v1**. The `day/accepted_exception` mapping above is the interim; the note keeps the claimed window auditable.

### 5.3 Echo + tag

Posted in the thread, keyed by the instructing reply's ts (`instructionAckKey(reportKey, "escalate", replyTs)`):

> 🔎 Тарас повідомляє: «дощ, запис не працював». Перевірив: відео 48 хв = 40% від 120 хв. Пропоную: прийняти як виняток (дощ, запис не працював). @Oleksandr K @Bohdan Forostianyi — «так» / «ні».

Approver mentions via `lib/mention.ts` (`mentionize`). When a verify step preceded, the fresh numbers are included.

### 5.4 Who drives a pilot-origin proposal

Only approvers. The existing confirm branch already sits behind `isApprover`; the pilot's own «так» is out of their schema and, if it slipped through, is stopped by the role gate. On confirm of a pilot-origin proposal the **confirmer** is recorded as `by` (today `by: p.proposedBy`; change to `origin === "pilot" ? approver.name : p.proposedBy`). «ні» cancels with the existing note.

### 5.5 Approver options in any thread

Exactly four: «так», «ні», an instruction with details (existing path), or a question (→ chat, §6). Nothing else is required of them.

## 6. Chat

- Residual replies (`chat`) go through the existing agent loop (`lib/agent/loop.ts`) under a new surface **`verdict-thread`**.
- `conversationKey = "verdict:" + thread_ts`. The namespace preserves the route.ts invariant that agent-thread keys never equal a verdict/ask ts (`agentThreadExists(rawTs)` cannot match).
- **Stateless:** no `agent_threads` rows written; each question stands alone with the verdict text + live thread transcript (`lib/agent/threadContext.ts`) as context.
- **Read tools only** + one new read tool **`field_verdict_status`** (date, reportTs → status, gaps in Ukrainian, numbers, links to the Звіт and thread). No write tools are registered on this surface, so a chat can never propose or apply.
- Reply threaded, chunked via `lib/slackChunk.ts` if long. Placeholder pattern as §3.4.
- Approvers and pilots alike; the approver gate on the agent surface (`lib/approvers.ts` refusal for non-approvers) does **not** apply here — the surface is read-only by construction.

## 7. Gap-question thread alignment (S5/S6)

- Replies in the bot's #datasets / #field-qa question threads go through the **same handler**. The ask record supplies `date` + `gapType`; the apply target is the published verdict for that date (dataset/video are day-shared axes, so multi-report days are fine).
- Proposals from a question thread have `threadTs = askedTs`; the echo tags approvers **in the question thread**. Approver replies in question threads now reach the confirm path (today they fall through to `applyAnswerReply`).
- `lib/applyAnswer.ts` no longer writes `accepted_exception` from an explanation. `data_provided` → verify; `accepted_exception` classification → pilot-origin proposal; `still_missing`/`unclear` → ask state only.
- `npm run field-remember` batch: prints the would-be actions; `--write` creates pilot-origin proposals (never resolutions).

## 8. Storage

New table **`evidence_events`** (audit; backs the web panel + CLI `--list`):

| column | notes |
|---|---|
| `id` | uuid |
| `thread_ts`, `channel` | the verdict/ask thread |
| `date`, `report_ts` | report identity (`report_ts` nullable) |
| `by_user_id`, `by_name`, `role` | author; role `approver`/`pilot` |
| `kind` | `evidence` / `claim` / `chat` / `unclear` |
| `evidence` | jsonb: extracted links + kinds |
| `outcome` | `closed` / `still_open` / `hard_fail` / `escalated` / `answered` / `silent` |
| `status_before`, `status_after` | verdict status |
| `source_reply_ts` | **unique** — redelivery-idempotent |
| `proposal_id` | nullable FK-ish to `proposals.id` when escalated |
| `created_at` | ISO |

`proposals.origin` column as §5.1. Neon migration applied manually (see memory `db-migrate-manual`).

## 9. CLI + web (both required)

- **CLI** `npm run field-evidence -- --thread <channelId:ts | permalink> --reply "<text>" [--as <name|userId>] [--write]` — runs the same `applyThreadReply` from the terminal. DRY-RUN by default: prints role, classification struct, dispatch action, verification outcome and the exact texts it would post. `--write` performs (verify + edit + ack / create proposal + echo / chat answer). `--list --start --end` prints evidence events + pilot-origin proposals, mirroring `GET /api/evidence`.
- **Web**: `GET /api/evidence?start=&end=` (committed-DB read) and a **«Докази від пілотів»** panel on the Instructions tab: evidence events table (date, who, kind, outcome, before→after, link) and pilot-origin proposals with an «від пілота» badge in the existing pending-proposals list.
- Agent read tool `field_verdict_status` is also reachable from `npm run agent -- "що бракує за 04.09?"`.

## 10. Idempotency, dedup, failure

- Slack `event_id` claim (existing) + `evidence_events.source_reply_ts` unique + `proposals.source_reply_ts` unique → a redelivered reply is a no-op at every layer.
- All outbound keys salted with the instructing reply's ts (2026-09-04 convention): placeholder, verify result, shortfall, escalation echo, chat answer.
- Verify failure (Vimeo/DB error) → edit the placeholder into «❌ Не вдалося перевірити: <reason>. Спробуйте пізніше або напишіть затверджувачам.» No `evidence_events` row is written, so a manual `npm run field-evidence --write` re-run of the same reply can redo it. Never applies partial data.
- Chat failure → placeholder edited into the existing agent error text.
- A skipped placeholder send (empty ts) throws, never scatters replies top-level (sprint/field-summary convention).

## 11. Testing

Pure, unit-tested:

- `buildThreadReplySchema(role, pendingEcho)` — per-role intent enum; `confirm`/`cancel` absent without a pending echo.
- `extractHints(text)` — Vimeo URLs, #datasets permalinks, time ranges, minutes.
- `decideThreadReply(...)` — priority table §3.3; pilot «так» → silent; pilot instruction → claim; evidence+claim → verify then escalate.
- `evidenceOutcome(statusBefore, statusAfter, hints, liveVideos)` — outcome + cause hints; hard-fail wording.
- Renderers: shortfall, closed ack, escalation echo (mentions both approvers), `field_verdict_status` tool output.
- Claim → axis/payload mapping (§5.1).

Orchestration (mocked Slack/Claude/DB, `lib/runSprint.test.ts` style):

- redelivered reply → no second event, no second post;
- pilot-origin proposal confirmed by approver → `by` = confirmer; confirmed by pilot → refused/silent;
- verify `closed` edits message + acks; `still_open` replies, no proposal; `hard_fail` never flips;
- chat surface never registers a write tool; conversation key namespaced; no memory rows;
- question-thread reply creates a proposal keyed on `askedTs`, applies to the verdict of that date.

## 12. Rollout

1. Migration: `proposals.origin`, `evidence_events`.
2. Ship handler + CLI behind the existing tracked-channel filter; dry-run on recent NEEDS_REVIEW threads via `npm run field-evidence` with real past replies.
3. Enable in the webhook. Announce in #field-qa (Ukrainian, one message): reply in the verdict thread with video/dataset links, the bot re-checks; explanations go to approvers.
4. Follow-up spec: `deploy` override axis (§5.2).

### Manual smoke (operator)

Reserved for a human operator — not run by the implementing agent. End-to-end smoke on the test channel:

1. Ensure `AGENT_RUN_SECRET`, `ANTHROPIC_API_KEY`, `SLACK_TOKEN`, `VIMEO_TOKEN`, `POSTGRES_URL` are set on Vercel; deploy.
2. In `#orients-ops-console-test`, pick (or publish via `npm run field-publish -- --channel orients-ops-console-test --publish` on a small window) a NEEDS_REVIEW verdict.
3. As a non-approver: reply «що ще бракує?» → expect «💬 Думаю…» edited into an answer, `evidence_events` row kind=chat.
4. Reply «дощ, запис не працював» → expect the 🔎 echo tagging both approvers; `npm run field-evidence -- --list …` shows a pilot proposal. As an approver reply «так» → applied, ack names the approver.
5. Reply with a Vimeo link → «🔎 Перевіряю…» edited into the shortfall/closed text.
6. Check `npm run sent -- --start … --end … --format table` shows every post keyed by the reply ts (feature `evidence`).

## 13. Files touched (expected)

- `lib/instructionClassifyPrompt.ts`, `lib/instructionClassify.ts` — role-narrowed schema, struct output.
- `lib/threadReplyDecide.ts` (new, pure) — hints + dispatch.
- `lib/applyThreadReply.ts` (new, server-only) — replaces the approver-only call site of `applyInstructionReply` in `app/api/slack/events/route.ts`; keeps `applyInstructionReply` for the approver branches.
- `lib/evidenceVerify.ts`, `lib/evidenceOutcome.ts` (new).
- `lib/evidenceEvents.ts` (new store), `lib/schema.ts`, `lib/proposals.ts` (`origin`).
- `lib/applyAnswer.ts` — no more auto-exception.
- `lib/agent/tools/fieldVerdictStatus.ts` (new read tool); `lib/agent/loop.ts` surface `verdict-thread`; `app/api/agent/run/route.ts` or new `app/api/field/thread-reply/route.ts`.
- `scripts/fieldEvidence.ts` + `package.json` script; `app/api/evidence/route.ts`; Instructions tab panel.
- CLAUDE.md entry.
