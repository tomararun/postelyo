CREATE TABLE "api_key" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{"read"}' NOT NULL,
	"created_by_user_id" uuid,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_log_archive" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" text,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"event" text NOT NULL,
	"from_state" text,
	"to_state" text,
	"correlation_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_key" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_connection" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_enc" "bytea" NOT NULL,
	"email_domain" text NOT NULL,
	"default_role" "membership_role" DEFAULT 'viewer' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_connection_email_domain_unique" UNIQUE("email_domain")
);
--> statement-breakpoint
CREATE TABLE "sso_state" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"pkce_verifier" text NOT NULL,
	"nonce" text NOT NULL,
	"redirect_to" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_delivery" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"audit_id" text,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_status_code" integer,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoint" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"secret_enc" "bytea" NOT NULL,
	"events" text[] DEFAULT '{}' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text,
	"last_delivery_at" timestamp with time zone,
	"last_status_code" integer,
	"cursor_audit_id" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_key" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"wrapped_key" "bytea" NOT NULL,
	"master_key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_connection" ADD CONSTRAINT "sso_connection_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_state" ADD CONSTRAINT "sso_state_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_endpoint_id_webhook_endpoint_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoint"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD CONSTRAINT "webhook_endpoint_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD CONSTRAINT "webhook_endpoint_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_key" ADD CONSTRAINT "workspace_key_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_key_workspace_idx" ON "api_key" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "audit_log_archive_ws_idx" ON "audit_log_archive" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_key_uq" ON "idempotency_key" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE INDEX "idempotency_created_idx" ON "idempotency_key" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sso_state_expires_idx" ON "sso_state" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "webhook_delivery_endpoint_idx" ON "webhook_delivery" USING btree ("endpoint_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_delivery_due_idx" ON "webhook_delivery" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "webhook_endpoint_workspace_idx" ON "webhook_endpoint" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "api_key" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_key" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "api_key_tenant" ON "api_key" USING (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id()) WITH CHECK (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id());--> statement-breakpoint
ALTER TABLE "idempotency_key" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "idempotency_key" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "idempotency_key_tenant" ON "idempotency_key" USING (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id()) WITH CHECK (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id());--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "webhook_endpoint_tenant" ON "webhook_endpoint" USING (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id()) WITH CHECK (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id());--> statement-breakpoint
ALTER TABLE "webhook_delivery" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_delivery" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "webhook_delivery_tenant" ON "webhook_delivery" USING (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id()) WITH CHECK (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id());--> statement-breakpoint
ALTER TABLE "workspace_key" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_key" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "workspace_key_tenant" ON "workspace_key" USING (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id()) WITH CHECK (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id());--> statement-breakpoint
ALTER TABLE "sso_connection" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sso_connection" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "sso_connection_tenant" ON "sso_connection" USING (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id()) WITH CHECK (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id());--> statement-breakpoint
ALTER TABLE "sso_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sso_state" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "sso_state_tenant" ON "sso_state" USING (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id()) WITH CHECK (app_tenant_id() IS NULL OR "workspace_id" = app_tenant_id());
