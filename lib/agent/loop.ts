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

const SYSTEM = [
  "Ти — асистент інженерної команди Orients у Slack. Ти вмієш шукати і змінювати задачі в Jira через інструменти.",
  "Правило мови: у вільній розмові й відповідях відповідай мовою користувача; підтвердження та echo для записів — українською.",
  "Маршрутизація виконавців у Jira автоматична — просто передай імʼя людини в jira_create.",
  "Будь-яка зміна (створення/коментар/перехід/оновлення) НЕ виконується одразу: інструмент повертає пропозицію, яку користувач підтверджує окремо.",
  "Для питань про зроблене/відкрите використовуй jira_search з відповідним JQL.",
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
    { role: "user", content: userText },
  ];

  for (let i = 0; i < maxIters; i++) {
    if (now() - started > BUDGET_MS) {
      return { kind: "error", text: "Вибач, не встиг обробити запит — спробуй ще раз." };
    }
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      tools: anthropicTools,
      messages,
    });
    const uses = toolUsesOf(resp.content);
    if (!uses.length) {
      return { kind: "text", text: textOf(resp.content) };
    }
    // A write tool_use → confirm-first Proposal; stop the loop immediately.
    const write = uses.find((u) => findTool(tools, u.name)?.kind === "write");
    if (write) {
      const tool = findTool(tools, write.name)!;
      const proposal = await tool.propose!(write.input);
      return { kind: "proposal", text: proposal.echoUk, proposal };
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
