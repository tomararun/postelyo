CREATE TYPE "public"."attempt_outcome" AS ENUM('succeeded', 'failed_retryable', 'failed_terminal', 'unknown');--> statement-breakpoint
CREATE TABLE "publish_attempt" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"cycle_no" integer NOT NULL,
	"attempt_no" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" "attempt_outcome",
	"error_code" text,
	"error_message" text,
	"scheduled_at" timestamp with time zone NOT NULL,
	"delay_seconds" integer,
	"request_meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_meta" jsonb,
	"worker_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "publish_attempt" ADD CONSTRAINT "publish_attempt_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_attempt" ADD CONSTRAINT "publish_attempt_publication_id_publication_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publication"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "publish_attempt_publication_idx" ON "publish_attempt" USING btree ("publication_id","started_at");