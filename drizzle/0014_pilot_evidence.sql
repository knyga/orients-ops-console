CREATE TABLE "evidence_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_ts" text NOT NULL,
	"channel" text NOT NULL,
	"date" text NOT NULL,
	"report_ts" text,
	"by_user_id" text NOT NULL,
	"by_name" text NOT NULL,
	"role" text NOT NULL,
	"kind" text NOT NULL,
	"evidence" jsonb,
	"outcome" text NOT NULL,
	"status_before" text,
	"status_after" text,
	"source_reply_ts" text NOT NULL,
	"proposal_id" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "origin" text DEFAULT 'approver' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_events_source_reply_ts" ON "evidence_events" USING btree ("source_reply_ts");--> statement-breakpoint
CREATE INDEX "evidence_events_date" ON "evidence_events" USING btree ("date");