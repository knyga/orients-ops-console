ALTER TABLE "resolutions" ADD COLUMN "report_ts" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "resolutions" DROP CONSTRAINT "resolutions_date_axis_pk";--> statement-breakpoint
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_date_axis_report_ts_pk" PRIMARY KEY("date","axis","report_ts");--> statement-breakpoint
ALTER TABLE "roster_corrections" ADD COLUMN "report_ts" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "roster_corrections" DROP CONSTRAINT "roster_corrections_pkey";--> statement-breakpoint
ALTER TABLE "roster_corrections" ADD CONSTRAINT "roster_corrections_date_report_ts_pk" PRIMARY KEY("date","report_ts");--> statement-breakpoint
ALTER TABLE "published" ADD COLUMN "report_ts" text;--> statement-breakpoint
ALTER TABLE "published" ADD COLUMN "verdict_key" text;--> statement-breakpoint
UPDATE "published" SET "verdict_key" = "date";--> statement-breakpoint
ALTER TABLE "published" ALTER COLUMN "verdict_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "published" DROP CONSTRAINT "published_period_date_pk";--> statement-breakpoint
ALTER TABLE "published" ADD CONSTRAINT "published_period_verdict_key_pk" PRIMARY KEY("period","verdict_key");--> statement-breakpoint
ALTER TABLE "bonus_notified" ADD COLUMN "report_ts" text;--> statement-breakpoint
ALTER TABLE "bonus_notified" ADD COLUMN "verdict_key" text;--> statement-breakpoint
UPDATE "bonus_notified" SET "verdict_key" = "date";--> statement-breakpoint
ALTER TABLE "bonus_notified" ALTER COLUMN "verdict_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bonus_notified" DROP CONSTRAINT "bonus_notified_period_date_pk";--> statement-breakpoint
ALTER TABLE "bonus_notified" ADD CONSTRAINT "bonus_notified_period_verdict_key_pk" PRIMARY KEY("period","verdict_key");
