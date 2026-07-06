/**
 * The agent's multi-turn tool-use loop. Drives claude-sonnet-5 with a tool set:
 * a read tool_use executes now and its result is fed back; a write tool_use is
 * turned into a confirm-first Proposal and the loop stops (the loop NEVER writes
 * to Jira directly). Text-only → answer. Guarded by an iteration cap and a
 * wall-clock budget so it fits Vercel's 60s function limit.
 *
 * SERVER-ONLY reachable (reads ANTHROPIC_API_KEY via the default Anthropic
 * client, and the tools read JIRA_*). Tests inject `client` + `tools` + `now`.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { Proposal, Tool } from "./tools/types";
import { toAnthropicTools, findTool } from "./tools/registry";
import { jiraTools } from "./tools/jira";

const MODEL = "claude-sonnet-5";
const MAX_ITERS = 8;
const BUDGET_MS = 50_000;
// On claude-sonnet-5, omitting `thinking` runs ADAPTIVE thinking, and max_tokens is a
// hard ceiling over thinking + answer combined. 1024 risks a reasoning-heavy turn
// spending the whole budget on thinking and returning truncated/empty text. Set thinking
// explicitly (version-independent — the omission default differs across models) and give
// max_tokens headroom; still well under the ~16K non-streaming HTTP-timeout threshold.
const MAX_TOKENS = 4096;

// The model has no clock: without an explicit date it guesses from training data
// (it once told a user June 2026 was "the future") and mis-builds relative JQL.
const kyivDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" });
const systemPrompt = (nowMs: number) => [
  `Сьогодні ${kyivDay.format(nowMs)} (Europe/Kyiv). Відлічуй «сьогодні», «цього місяця» тощо від цієї дати.`,
  "Ти — асистент інженерної команди Orients у Slack. Ти вмієш шукати і змінювати задачі в Jira через інструменти.",
  "Правило мови: у вільній розмові й відповідях відповідай мовою користувача; підтвердження та echo для записів — українською.",
  "Маршрутизація виконавців у Jira автоматична — просто передай імʼя людини в jira_create.",
  "Будь-яка зміна (створення/коментар/перехід/оновлення) НЕ виконується одразу: інструмент повертає пропозицію, яку користувач підтверджує окремо.",
  "Для питань про зроблене/відкрите використовуй jira_search з відповідним JQL.",
  "«Додай задачу в наступний спринт» — це jira_add_to_next_sprint (спринт визначається автоматично); jira_update для спринтів не підходить.",
  "Ніколи не пиши «Підтвердити? (так/ні)» звичайним текстом: підтвердження існує лише коли інструмент запису повернув пропозицію. Якщо інструмент повернув помилку — поясни її і не імітуй підтвердження.",
].join("\n");

export type AnthropicLike = {
  messages: { create(body: unknown): Promise<{ stop_reason: string | null; content: unknown[] }> };
};
export interface AgentResult {
  kind: "text" | "proposal" | "error";
  text: string;
  proposal?: Proposal;
}
export interface RunAgentOptions {
  tools?: Tool[];
  client?: AnthropicLike;
  maxIters?: number;
  now?: () => number;
  /** Prior conversation turns (lightweight text) seeded before the new user message. */
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  /** Permalink of the Slack thread this turn came from — attached to write
   *  proposals deterministically (e.g. linked in a created ticket). */
  sourceUrl?: string;
}

interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
interface TextBlock { type: "text"; text: string }

function textOf(content: unknown[]): string {
  return content
    .filter((b): b is TextBlock => (b as { type?: string }).type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
function toolUsesOf(content: unknown[]): ToolUseBlock[] {
  return content.filter((b): b is ToolUseBlock => (b as { type?: string }).type === "tool_use");
}

export async function runAgent(userText: string, opts: RunAgentOptions = {}): Promise<AgentResult> {
  const tools = opts.tools ?? jiraTools;
  const client = (opts.client ?? new Anthropic()) as AnthropicLike;
  const maxIters = opts.maxIters ?? MAX_ITERS;
  const now = opts.now ?? (() => Date.now());
  const started = now();

  const anthropicTools = toAnthropicTools(tools);
  const messages: { role: "user" | "assistant"; content: unknown }[] = [
    ...(opts.history ?? []).map((h) => ({ role: h.role, content: h.text as unknown })),
    { role: "user", content: userText },
  ];

  for (let i = 0; i < maxIters; i++) {
    if (now() - started > BUDGET_MS) {
      return { kind: "error", text: "Вибач, не встиг обробити запит — спробуй ще раз." };
    }
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      system: systemPrompt(started),
      tools: anthropicTools,
      messages,
    });
    const uses = toolUsesOf(resp.content);
    if (!uses.length) {
      return { kind: "text", text: textOf(resp.content) };
    }
    // A write tool_use → confirm-first Proposal; stop the loop immediately.
    // If a turn mixes read and write tool_uses, the loop stops at the write and does NOT execute the reads.
    const write = uses.find((u) => findTool(tools, u.name)?.kind === "write");
    if (write) {
      const tool = findTool(tools, write.name)!;
      try {
        const proposal = await tool.propose!(write.input, { sourceUrl: opts.sourceUrl });
        return { kind: "proposal", text: proposal.echoUk, proposal };
      } catch (err) {
        // A propose failure (e.g. an unresolvable person) must not kill the
        // turn: feed it back as a tool_result so the model can recover or ask
        // the user, like the read-tool error path below. Every tool_use in the
        // response needs a result, so the skipped ones get a stub.
        const message = err instanceof Error ? err.message : String(err);
        messages.push({ role: "assistant", content: resp.content });
        messages.push({
          role: "user",
          content: uses.map((u) =>
            u.id === write.id
              ? { type: "tool_result", tool_use_id: u.id, content: `Error: ${message}`, is_error: true }
              : { type: "tool_result", tool_use_id: u.id, content: "Skipped: another tool call in this turn failed." },
          ),
        });
        continue;
      }
    }
    // Otherwise execute all read tool_uses and feed results back.
    messages.push({ role: "assistant", content: resp.content });
    const results: unknown[] = [];
    for (const u of uses) {
      const tool = findTool(tools, u.name);
      let content: string;
      try {
        const r = tool?.run ? await tool.run(u.input) : { ok: false, content: `Unknown tool ${u.name}` };
        content = r.content;
      } catch (err) {
        content = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      results.push({ type: "tool_result", tool_use_id: u.id, content });
    }
    messages.push({ role: "user", content: results });
  }
  return { kind: "error", text: "Вибач, не встиг обробити запит — спробуй ще раз." };
}
