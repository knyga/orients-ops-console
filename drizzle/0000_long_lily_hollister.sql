CREATE TABLE "asks" (
	"period" text NOT NULL,
	"gap_key" text NOT NULL,
	"gap_type" text NOT NULL,
	"date" text NOT NULL,
	"channel" text NOT NULL,
	"question" text NOT NULL,
	"state" text NOT NULL,
	"asked_ts" text NOT NULL,
	"asked_at" text NOT NULL,
	"note" text,
	CONSTRAINT "asks_period_gap_key_pk" PRIMARY KEY("period","gap_key")
);
--> statement-breakpoint
CREATE TABLE "published" (
	"period" text NOT NULL,
	"date" text NOT NULL,
	"channel" text NOT NULL,
	"text" text NOT NULL,
	"ts" text NOT NULL,
	"posted_at" text NOT NULL,
	"override" jsonb,
	CONSTRAINT "published_period_date_pk" PRIMARY KEY("period","date")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"feature" text NOT NULL,
	"period" text NOT NULL,
	"json" jsonb NOT NULL,
	"csv" text,
	"updated_at" text NOT NULL,
	CONSTRAINT "reports_feature_period_pk" PRIMARY KEY("feature","period")
);
--> statement-breakpoint
CREATE TABLE "resolutions" (
	"date" text PRIMARY KEY NOT NULL,
	"decision" text NOT NULL,
	"note" text NOT NULL,
	"source" text NOT NULL,
	"by" text,
	"recorded_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_messages" (
	"channel" text NOT NULL,
	"ts" text NOT NULL,
	"author_id" text NOT NULL,
	"author" text NOT NULL,
	"iso_time" text NOT NULL,
	"text" text NOT NULL,
	"permalink" text NOT NULL,
	"files" jsonb,
	"thread_ts" text,
	"reply_count" integer,
	"edited" text,
	"deleted" boolean,
	"first_seen" text NOT NULL,
	"last_seen" text NOT NULL,
	CONSTRAINT "slack_messages_channel_ts_pk" PRIMARY KEY("channel","ts")
);
--> statement-breakpoint
CREATE TABLE "slack_sync" (
	"channel" text PRIMARY KEY NOT NULL,
	"last_sync" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "slack_messages_channel_iso_time" ON "slack_messages" USING btree ("channel","iso_time");--> statement-breakpoint
CREATE INDEX "slack_messages_channel_thread_ts" ON "slack_messages" USING btree ("channel","thread_ts");