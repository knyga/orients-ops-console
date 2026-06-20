/**
 * Committed list of Slack channels this bot reads, for the Orients workspace
 * (orientsai.slack.com). These are the real channel ids — the bot must be a
 * member of each (conversations.history returns nothing otherwise). Adding a
 * channel is a small PR. `id` is the Slack channel id (Channel → View channel
 * details → bottom of the dialog, or the last path segment of the archive URL).
 * `name` is the human handle and is the value an obligation's `channel` field
 * matches against in lib/policyRegistry.
 *
 * NOTE: lib/slack.ts fetches every channel listed here on each call. Names must
 * stay in sync with whatever consumers match on (lib/policyRegistry obligations,
 * the field-qa flight-hours reader, etc.).
 */
export interface SlackChannel {
  id: string;
  name: string;
}

export const TRACKED_CHANNELS: SlackChannel[] = [
  { id: "C09M551C9UK", name: "issue-log" },
  { id: "C08GX9DE54P", name: "general" },
  { id: "C08GY2NKF9D", name: "field-qa" },
  { id: "C08KG802THU", name: "datasets" },
  { id: "C09ETTREPCY", name: "order_writeoff" },
  // The bot's own channels: its home (where it posts verdicts) + a test channel.
  { id: "C0BC38K9LUC", name: "orients-ops-console" },
  { id: "C0BC1GT1G4R", name: "orients-ops-console-test" },
];
