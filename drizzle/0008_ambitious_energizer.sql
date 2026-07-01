CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_ts" text NOT NULL,
	"channel" text NOT NULL,
	"date" text NOT NULL,
	"axis" text NOT NULL,
	"payload" jsonb NOT NULL,
	"summary_uk" text NOT NULL,
	"proposed_by" text NOT NULL,
	"source_reply_ts" text NOT NULL,
	"state" text NOT NULL,
	"created_at" text NOT NULL,
	"resolved_at" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_source_reply_ts" ON "proposals" USING btree ("source_reply_ts");--> statement-breakpoint
CREATE INDEX "proposals_thread_ts_state" ON "proposals" USING btree ("thread_ts","state");--> statement-breakpoint
CREATE INDEX "proposals_date" ON "proposals" USING btree ("date");