CREATE TABLE "agent_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" text NOT NULL,
	"kind" text NOT NULL,
	"params" jsonb NOT NULL,
	"summary_uk" text NOT NULL,
	"proposed_by" text NOT NULL,
	"state" text NOT NULL,
	"created_at" text NOT NULL,
	"resolved_at" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_proposals_one_pending" ON "agent_proposals" USING btree ("channel_id") WHERE state = 'PENDING';--> statement-breakpoint
CREATE INDEX "agent_proposals_channel" ON "agent_proposals" USING btree ("channel_id");