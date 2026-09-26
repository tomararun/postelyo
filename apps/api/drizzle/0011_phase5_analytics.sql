CREATE TABLE "publication_metric" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"provider" "social_provider" NOT NULL,
	"tier" integer NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"impressions" integer,
	"reach" integer,
	"reactions" integer,
	"comments" integer,
	"shares" integer,
	"clicks" integer,
	"saves" integer,
	"raw" jsonb
);
--> statement-breakpoint
ALTER TABLE "membership" ADD COLUMN "weekly_report" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "publication" ADD COLUMN "metrics_tier" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "publication" ADD COLUMN "metrics_next_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "publication" ADD COLUMN "metrics_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "publication" ADD COLUMN "metrics_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "publication" ADD COLUMN "metrics_error" text;--> statement-breakpoint
ALTER TABLE "publication_metric" ADD CONSTRAINT "publication_metric_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_metric" ADD CONSTRAINT "publication_metric_publication_id_publication_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publication"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "publication_metric_tier_uq" ON "publication_metric" USING btree ("publication_id","tier");--> statement-breakpoint
CREATE INDEX "publication_metric_workspace_idx" ON "publication_metric" USING btree ("workspace_id","fetched_at");--> statement-breakpoint
ALTER TABLE "publication_metric" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "publication_metric" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "publication_metric_tenant" ON "publication_metric" USING (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id()) WITH CHECK (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id());
