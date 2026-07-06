CREATE TABLE "loss_alerts" (
	"period" text PRIMARY KEY NOT NULL,
	"last_alerted_count" integer NOT NULL,
	"fieldqa_warned_at_3" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loss_records" (
	"date" text NOT NULL,
	"report_ts" text NOT NULL,
	"lost" boolean NOT NULL,
	"found" boolean NOT NULL,
	"note" text NOT NULL,
	"source" text NOT NULL,
	"crash_text_hash" text,
	"updated_at" text NOT NULL,
	"updated_by" text,
	CONSTRAINT "loss_records_date_report_ts_pk" PRIMARY KEY("date","report_ts")
);
