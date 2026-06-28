CREATE TABLE "bonus_notified" (
	"period" text NOT NULL,
	"date" text NOT NULL,
	"thread_ts" text,
	"dms" jsonb NOT NULL,
	CONSTRAINT "bonus_notified_period_date_pk" PRIMARY KEY("period","date")
);
