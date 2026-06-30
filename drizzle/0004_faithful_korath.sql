ALTER TABLE "resolutions" ADD COLUMN "axis" text DEFAULT 'day' NOT NULL;
--> statement-breakpoint
ALTER TABLE "resolutions" DROP CONSTRAINT "resolutions_pkey";
--> statement-breakpoint
ALTER TABLE "resolutions" ADD CONSTRAINT "resolutions_date_axis_pk" PRIMARY KEY("date","axis");
