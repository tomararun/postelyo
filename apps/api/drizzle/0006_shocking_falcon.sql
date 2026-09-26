CREATE TABLE "alert_state" (
	"kind" text NOT NULL,
	"entity_key" text NOT NULL,
	"workspace_id" uuid,
	"last_sent_at" timestamp with time zone NOT NULL,
	"send_count" integer DEFAULT 1 NOT NULL,
	"last_message" text,
	CONSTRAINT "alert_state_kind_entity_key_pk" PRIMARY KEY("kind","entity_key")
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeat" (
	"instance_id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"version" text
);
--> statement-breakpoint
ALTER TABLE "social_account" ADD COLUMN "reauth_reminder_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "social_account" ADD COLUMN "reauth_notified_at" timestamp with time zone;