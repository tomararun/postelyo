CREATE TYPE "public"."content_source_kind" AS ENUM('notion', 'native');--> statement-breakpoint
CREATE TYPE "public"."content_source_status" AS ENUM('active', 'error', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."social_account_status" AS ENUM('active', 'needs_reauth', 'revoked', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."social_provider" AS ENUM('linkedin', 'x', 'instagram', 'facebook');--> statement-breakpoint
CREATE TABLE "content_source" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "content_source_kind" NOT NULL,
	"status" "content_source_status" NOT NULL,
	"external_database_id" text,
	"external_database_title" text,
	"credential_enc" "bytea",
	"credential_key_id" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cursor" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"connected_by_user_id" uuid,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_state" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "social_provider" NOT NULL,
	"pkce_verifier" text,
	"redirect_to" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" "social_provider" NOT NULL,
	"account_type" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"status" "social_account_status" NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"access_token_enc" "bytea",
	"refresh_token_enc" "bytea",
	"credential_key_id" text,
	"token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"connected_by_user_id" uuid,
	"last_used_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_source" ADD CONSTRAINT "content_source_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_source" ADD CONSTRAINT "content_source_connected_by_user_id_user_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_state" ADD CONSTRAINT "oauth_state_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_state" ADD CONSTRAINT "oauth_state_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_account" ADD CONSTRAINT "social_account_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_account" ADD CONSTRAINT "social_account_connected_by_user_id_user_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_source_database_uq" ON "content_source" USING btree ("workspace_id","kind","external_database_id");--> statement-breakpoint
CREATE INDEX "content_source_workspace_idx" ON "content_source" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "oauth_state_expires_idx" ON "oauth_state" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "social_account_provider_uq" ON "social_account" USING btree ("workspace_id","provider","provider_account_id");--> statement-breakpoint
CREATE INDEX "social_account_workspace_idx" ON "social_account" USING btree ("workspace_id","status");