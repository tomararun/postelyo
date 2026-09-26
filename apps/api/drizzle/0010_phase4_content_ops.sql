CREATE TABLE "approval" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"content_fp" text NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "campaign" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"content_source_id" uuid,
	"external_id" text NOT NULL,
	"external_url" text,
	"name" text NOT NULL,
	"source_status" text,
	"starts_on" text,
	"ends_on" text,
	"summary" jsonb,
	"summary_hash" text,
	"summary_written_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "short_link" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"publication_id" uuid,
	"code" text NOT NULL,
	"target_url" text NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"last_click_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "short_link_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "parent_post_id" uuid;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "series_key" text;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "series_fp" text;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "series_source_hash" text;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "repeat_rule" text;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "repeat_until" text;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "approval_fp" text;--> statement-breakpoint
ALTER TABLE "publication" ADD COLUMN "first_comment_state" text;--> statement-breakpoint
ALTER TABLE "publication" ADD COLUMN "first_comment_id" text;--> statement-breakpoint
ALTER TABLE "publication" ADD COLUMN "first_comment_error" text;--> statement-breakpoint
ALTER TABLE "publication" ADD COLUMN "first_comment_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_content_source_id_content_source_id_fk" FOREIGN KEY ("content_source_id") REFERENCES "public"."content_source"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_link" ADD CONSTRAINT "short_link_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "short_link" ADD CONSTRAINT "short_link_publication_id_publication_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publication"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_post_idx" ON "approval" USING btree ("post_id","approved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_source_external_uq" ON "campaign" USING btree ("content_source_id","external_id");--> statement-breakpoint
CREATE INDEX "campaign_workspace_idx" ON "campaign" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "short_link_publication_idx" ON "short_link" USING btree ("publication_id");--> statement-breakpoint
CREATE UNIQUE INDEX "short_link_publication_target_uq" ON "short_link" USING btree ("publication_id","target_url");--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_campaign_id_campaign_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaign"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_parent_post_id_post_id_fk" FOREIGN KEY ("parent_post_id") REFERENCES "public"."post"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "post_series_key_uq" ON "post" USING btree ("content_source_id","series_key") WHERE "post"."series_key" is not null;--> statement-breakpoint
CREATE INDEX "post_parent_idx" ON "post" USING btree ("parent_post_id");--> statement-breakpoint
ALTER TABLE "campaign" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "campaign" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "campaign_tenant" ON "campaign" USING (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id()) WITH CHECK (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id());--> statement-breakpoint
ALTER TABLE "approval" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "approval" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "approval_tenant" ON "approval" USING (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id()) WITH CHECK (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id());--> statement-breakpoint
ALTER TABLE "short_link" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "short_link" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "short_link_tenant" ON "short_link" USING (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id()) WITH CHECK (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id());
