/**
 * Read-only, STATELESS agent turn for a verdict thread (pilot evidence autonomy,
 * spec §6). No memory rows, no write tools — a chat here can never propose or
 * apply. Context = the verdict text + the live thread transcript. Tests mock ./loop.
 */
import { runAgent } from "./loop";
import { fetchThreadContext } from "./threadContext";
import { expandSlackLinks } from "./slackLinkContext";
import { fieldVerdictTools } from "./tools/fieldVerdict";
import { fieldLossTools } from "./tools/fieldLoss";
import { makeSlackReadTools } from "./tools/slackRead";
import { markdownToMrkdwn } from "@/lib/mrkdwn";

const MAX_ITERS = 4;

export async function runVerdictChat(a: { question: string; verdictText: string; channelId: string; threadTs: string; excludeTs: string[] }): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set on the server.");
  let ctx: string | null = null;
  try {
    ctx = await fetchThreadContext(a.channelId, a.threadTs, a.excludeTs);
  } catch (err) {
    console.error("verdictChat: thread-context fetch failed:", err);
  }
  // A pasted Slack permalink («ось звіт: https://…») is read deterministically;
  // links into this very thread are skipped (already in ctx). Never throws.
  // Pilots ask here, not only approvers — so link reading is BOUND to the
  // verdict's own channel: a private-channel permalink is refused, not fetched.
  const allowedChannelIds = [a.channelId];
  const links = await expandSlackLinks(a.question, { skipThread: { channelId: a.channelId, threadTs: a.threadTs }, allowedChannelIds });
  const text = [
    "Ти відповідаєш у треді вердикту польового дня в Slack. Відповідай коротко, українською, лише фактами з вердикту та інструментів.",
    "Ти НЕ можеш приймати чи змінювати день — якщо просять, поясни: докази (відео/датасет) перевіряю сам, пояснення передаю затверджувачам.",
    "",
    "ВЕРДИКТ:",
    a.verdictText,
    ...(ctx ? ["", ctx] : []),
    ...(links ? ["", links] : []),
    "",
    "ПИТАННЯ:",
    a.question,
  ].join("\n");
  const tools = [...fieldVerdictTools, ...fieldLossTools, ...makeSlackReadTools({ allowedChannelIds })].filter((t) => t.kind === "read");
  const result = await runAgent(text, { tools, maxIters: MAX_ITERS });
  return markdownToMrkdwn(result.text.trim()) || "Не маю відповіді на це.";
}
