/**
 * Pure prompt construction for the per-user occupation summary. Kept separate
 * from lib/summarize.ts (which is server-only and hits the Anthropic API) so the
 * prompt shape can be unit-tested without a network call or the server-only guard.
 */
import type { UserTickets } from "./jiraStats";

/**
 * Build the user message asking Claude to describe what one person worked on,
 * based purely on the titles of the issues they resolved. Constrained to under
 * 200 words; ticket titles may be in any language (we don't translate them).
 */
export function buildOccupationPrompt(user: UserTickets): string {
  const list = user.tickets
    .map((t) => `- ${t.key}: ${t.summary}`)
    .join("\n");
  return [
    `You are summarizing what a software engineer worked on during a reporting period, based only on the work items they delivered (Jira issues, pull requests, and/or commits).`,
    ``,
    `Engineer: ${user.displayName}`,
    `Work items (id: title — titles may be in Ukrainian, keep proper nouns as-is):`,
    list,
    ``,
    `Write a concise occupation summary in English describing their focus areas and the kind of work they did (e.g. detection/CV pipeline, flight control, OS/infra, tooling). Group related issues into themes rather than listing every ticket. Be factual; do not speculate beyond the titles. Strictly under 200 words. Output only the summary prose — no preamble, headings, or bullet list.`,
  ].join("\n");
}
