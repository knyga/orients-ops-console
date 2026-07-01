CREATE TABLE "airborne_overrides" (
	"date" text PRIMARY KEY NOT NULL,
	"minutes" real NOT NULL,
	"note" text NOT NULL,
	"by" text NOT NULL,
	"source" text NOT NULL,
	"recorded_at" text NOT NULL
);
