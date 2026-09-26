CREATE TYPE "public"."post_state" AS ENUM('draft', 'in_review', 'changes_requested', 'ready', 'scheduled', 'publishing', 'published', 'partially_failed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."publication_state" AS ENUM('pending', 'scheduled', 'blocked', 'queued', 'publishing', 'retry_wait', 'published', 'failed', 'ambiguous', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."writeback_state" AS ENUM('pending', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "media_asset" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"source_url" text NOT NULL,
	"source_kind" text NOT NULL,
	"name" text NOT NULL,
	"mime_type" text,
	"byte_size" integer,
	"content_hash" text,
	"provider_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"content_source_id" uuid,
	"external_id" text,
	"external_url" text,
	"title" text NOT NULL,
	"state" "post_state" NOT NULL,
	"source_status" text,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" text DEFAULT '' NOT NULL,
	"source_edited_at" timestamp with time zone,
	"requested_platforms" text[] DEFAULT '{}' NOT NULL,
	"requested_publish_local" text,
	"requested_timezone" text,
	"validation_errors" jsonb,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cycle_no" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publication" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"social_account_id" uuid NOT NULL,
	"provider" "social_provider" NOT NULL,
	"state" "publication_state" NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"scheduled_tz" text NOT NULL,
	"scheduled_local" text NOT NULL,
	"content_override" jsonb,
	"cycle_no" integer DEFAULT 0 NOT NULL,
	"attempt_no" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"queued_at" timestamp with time zone,
	"publishing_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"delay_seconds" integer,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"provider_post_id" text,
	"provider_post_url" text,
	"last_error_code" text,
	"last_error_message" text,
	"writeback_state" "writeback_state" DEFAULT 'pending' NOT NULL,
	"writeback_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media_asset" ADD CONSTRAINT "media_asset_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_asset" ADD CONSTRAINT "media_asset_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_content_source_id_content_source_id_fk" FOREIGN KEY ("content_source_id") REFERENCES "public"."content_source"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication" ADD CONSTRAINT "publication_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication" ADD CONSTRAINT "publication_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication" ADD CONSTRAINT "publication_social_account_id_social_account_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_asset_post_idx" ON "media_asset" USING btree ("post_id");--> statement-breakpoint
CREATE UNIQUE INDEX "post_source_external_uq" ON "post" USING btree ("content_source_id","external_id");--> statement-breakpoint
CREATE INDEX "post_workspace_state_idx" ON "post" USING btree ("workspace_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "publication_post_account_uq" ON "publication" USING btree ("post_id","social_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "publication_provider_post_uq" ON "publication" USING btree ("social_account_id","provider_post_id") WHERE "publication"."provider_post_id" is not null;--> statement-breakpoint
CREATE INDEX "publication_due_idx" ON "publication" USING btree ("state","scheduled_at");--> statement-breakpoint
CREATE INDEX "publication_workspace_state_idx" ON "publication" USING btree ("workspace_id","state");