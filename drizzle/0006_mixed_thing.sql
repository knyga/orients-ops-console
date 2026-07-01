CREATE TABLE "slack_events_seen" (
	"event_id" text PRIMARY KEY NOT NULL,
	"seen_at" text NOT NULL,
	"event_type" text,
	"outcome" text
);
