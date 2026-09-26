CREATE TABLE "webhook_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid,
	"source" text NOT NULL,
	"external_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"entity_id" text,
	"received_at" timestamp with time zone NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"outcome" text
);
--> statement-breakpoint
ALTER TABLE "oauth_state" ADD COLUMN "account_type" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "publication" ADD COLUMN "deferred_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "publication" ADD COLUMN "reconcile_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_event" ADD CONSTRAINT "webhook_event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_event_source_external_uq" ON "webhook_event" USING btree ("source","external_event_id");--> statement-breakpoint
CREATE INDEX "webhook_event_received_idx" ON "webhook_event" USING btree ("received_at");--> statement-breakpoint
-- Row-level security (architecture §4 item 7, security.md §4.2). The app sets
-- `app.workspace_id` per transaction (infra/db/tenant-scope.ts); unset = system scope.
CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  select nullif(current_setting('app.workspace_id', true), '')::uuid
$$;--> statement-breakpoint
ALTER TABLE "workspace" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "workspace_tenant" ON "workspace" USING (app_tenant_id() IS NULL OR "id" = app_tenant_id()) WITH CHECK (app_tenant_id() IS NULL OR "id" = app_tenant_id());--> statement-breakpoint
ALTER TABLE "membership" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "membership" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "membership_tenant" ON "membership" USING (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id()) WITH CHECK (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id());--> statement-breakpoint
ALTER TABLE "social_account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "social_account" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "social_account_tenant" ON "social_account" USING (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id()) WITH CHECK (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id());--> statement-breakpoint
ALTER TABLE "oauth_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "oauth_state" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "oauth_state_tenant" ON "oauth_state" USING (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id()) WITH CHECK (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id());--> statement-breakpoint
ALTER TABLE "content_source" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "content_source" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "content_source_tenant" ON "content_source" USING (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id()) WITH CHECK (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id());--> statement-breakpoint
ALTER TABLE "post" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "post" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "post_tenant" ON "post" USING (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id()) WITH CHECK (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id());--> statement-breakpoint
ALTER TABLE "publication" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "publication" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "publication_tenant" ON "publication" USING (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id()) WITH CHECK (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id());--> statement-breakpoint
ALTER TABLE "publish_attempt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "publish_attempt" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "publish_attempt_tenant" ON "publish_attempt" USING (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id()) WITH CHECK (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id());--> statement-breakpoint
ALTER TABLE "media_asset" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "media_asset" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "media_asset_tenant" ON "media_asset" USING (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id()) WITH CHECK (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id());--> statement-breakpoint
ALTER TABLE "webhook_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "webhook_event_tenant" ON "webhook_event" USING (app_tenant_id() IS NULL OR "workspace_id" IS NULL OR "workspace_id" = app_tenant_id()) WITH CHECK (app_tenant_id() IS NULL OR "workspace_id" IS NULL OR "workspace_id" = app_tenant_id());--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "audit_log_tenant" ON "audit_log" USING (app_tenant_id() IS NULL OR "workspace_id" IS NULL OR "workspace_id" = app_tenant_id()) WITH CHECK (app_tenant_id() IS NULL OR "workspace_id" IS NULL OR "workspace_id" = app_tenant_id());
