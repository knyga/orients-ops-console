CREATE TABLE "outbound_messages" (
	"key" text PRIMARY KEY NOT NULL,
	"feature" text NOT NULL,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"channel_id" text NOT NULL,
	"text" text NOT NULL,
	"thread_ts" text,
	"ts" text,
	"status" text NOT NULL,
	"origin" text NOT NULL,
	"trigger" text NOT NULL,
	"error" text,
	"attempts" integer NOT NULL,
	"reserved_at" text NOT NULL,
	"sent_at" text
);
--> statement-breakpoint
CREATE INDEX "outbound_messages_sent_at" ON "outbound_messages" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX "outbound_messages_feature" ON "outbound_messages" USING btree ("feature");