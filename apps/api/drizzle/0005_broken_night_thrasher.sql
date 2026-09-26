ALTER TABLE "media_asset" ADD COLUMN "width" integer;--> statement-breakpoint
ALTER TABLE "media_asset" ADD COLUMN "height" integer;--> statement-breakpoint
ALTER TABLE "media_asset" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "media_asset" ADD COLUMN "inspected_at" timestamp with time zone;