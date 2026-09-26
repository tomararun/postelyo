CREATE TABLE "media_object" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"variants" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_referenced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media_asset" ADD COLUMN "media_object_id" uuid;--> statement-breakpoint
ALTER TABLE "social_account" ADD COLUMN "parent_account_id" uuid;--> statement-breakpoint
ALTER TABLE "social_account" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "media_object" ADD CONSTRAINT "media_object_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_object_workspace_hash_uq" ON "media_object" USING btree ("workspace_id","content_hash");--> statement-breakpoint
CREATE INDEX "media_object_referenced_idx" ON "media_object" USING btree ("last_referenced_at");--> statement-breakpoint
ALTER TABLE "media_asset" ADD CONSTRAINT "media_asset_media_object_id_media_object_id_fk" FOREIGN KEY ("media_object_id") REFERENCES "public"."media_object"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_object" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "media_object" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "media_object_tenant" ON "media_object" USING (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id()) WITH CHECK (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id());
