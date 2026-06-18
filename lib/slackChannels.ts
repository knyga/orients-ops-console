/**
 * Committed list of Slack channels the policy tracker reads. Adding a channel is
 * a small PR. `id` is the Slack channel id (e.g. C0123ABCD — Channel → View
 * channel details → bottom of the dialog). `name` is the human handle and is the
 * value an obligation's `channel` field matches against in lib/policyRegistry.
 *
 * Replace the placeholder ids with the workspace's real channel ids before the
 * first run; the names must stay in sync with lib/policyRegistry obligations.
 */
export interface SlackChannel {
  id: string;
  name: string;
}

export const TRACKED_CHANNELS: SlackChannel[] = [
  { id: "C_BUDGETS_REPLACE_ME", name: "budgets" },
  { id: "C_STATS_REPLACE_ME", name: "stats" },
  { id: "C_FIELD_REPORTS_REPLACE_ME", name: "field-reports" },
  { id: "C_FIELD_QA_REPLACE_ME", name: "field-qa" },
  { id: "C_DATASETS_REPLACE_ME", name: "datasets" },
];
