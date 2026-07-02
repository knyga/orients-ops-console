CREATE TABLE "agent_threads" (
	"channel_id" text PRIMARY KEY NOT NULL,
	"updated_at" text NOT NULL,
	"transcript" jsonb NOT NULL
);
