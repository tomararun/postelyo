CREATE TABLE "ai_generation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"prompt_text" text NOT NULL,
	"output_text" text DEFAULT '' NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" text DEFAULT '0' NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"outcome" text NOT NULL,
	"error" text,
	"created_by_actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media_asset" ADD COLUMN "alt_text" text;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "ai_assisted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_generation" ADD CONSTRAINT "ai_generation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_generation_workspace_idx" ON "ai_generation" USING btree ("workspace_id","created_at");--> statement-breakpoint
ALTER TABLE "ai_generation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_generation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ai_generation_tenant" ON "ai_generation" USING (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id()) WITH CHECK (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id());
