CREATE TABLE "roster_corrections" (
	"date" text PRIMARY KEY NOT NULL,
	"roster" jsonb,
	"eligibility" jsonb,
	"note" text NOT NULL,
	"by" text NOT NULL,
	"source" text NOT NULL,
	"recorded_at" text NOT NULL
);
