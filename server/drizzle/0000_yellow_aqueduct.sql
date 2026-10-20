CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"metadata_json" jsonb,
	"request_id" text,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "background_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"job_type" text NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"completed_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carrier_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"carrier_code" text NOT NULL,
	"status" text DEFAULT 'not_configured' NOT NULL,
	"encrypted_credentials_json" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"poll_interval_minutes" integer DEFAULT 60 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carriers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"code" text NOT NULL,
	"display_name" text NOT NULL,
	"adapter_type" text DEFAULT 'manual' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"tracking_url_template" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"template_type" text NOT NULL,
	"to_address" text NOT NULL,
	"from_address" text NOT NULL,
	"subject" text NOT NULL,
	"body_text" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider_message_id" text,
	"failure_code" text,
	"safe_failure_message" text,
	"related_shipment_id" uuid,
	"idempotency_key" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"subject" text NOT NULL,
	"body_html" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exception_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"exception_id" uuid NOT NULL,
	"user_id" uuid,
	"comment" text NOT NULL,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_row_errors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"error_code" text NOT NULL,
	"safe_message" text NOT NULL,
	"redacted_row_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"uploaded_by" uuid,
	"filename_safe" text NOT NULL,
	"status" text DEFAULT 'previewed' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"successful_rows" integer DEFAULT 0 NOT NULL,
	"failed_rows" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"carrier_code" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"fetched_count" integer DEFAULT 0 NOT NULL,
	"inserted_count" integer DEFAULT 0 NOT NULL,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"safe_error_message" text
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"invited_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"event_id" uuid,
	"recipient_hash" text NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"event_type" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider_message_id" text,
	"failure_code" text,
	"safe_failure_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"template_id" text NOT NULL,
	"recipient_policy" text DEFAULT 'customer_email' NOT NULL,
	"cooldown_minutes" integer DEFAULT 360 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"default_carrier_code" text DEFAULT 'manual' NOT NULL,
	"stalled_after_hours" integer DEFAULT 72 NOT NULL,
	"auto_open_exceptions" boolean DEFAULT true NOT NULL,
	"default_cooldown_minutes" integer DEFAULT 360 NOT NULL,
	"quiet_hours_start" text,
	"quiet_hours_end" text,
	"max_shipments" integer DEFAULT 5000 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"country_code" text DEFAULT 'US' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"base_currency" text DEFAULT 'USD' NOT NULL,
	"logo_url" text,
	"address_line1" text,
	"city" text,
	"postal_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"active_organization_id" uuid,
	"user_agent" text,
	"ip_address" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "shipment_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"type" text NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"assigned_user_id" uuid,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution_reason" text,
	"detail" text,
	"last_event_id" uuid,
	"last_notified_at" timestamp with time zone,
	"reopen_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"tracking_number" text NOT NULL,
	"carrier_code" text DEFAULT 'manual' NOT NULL,
	"order_reference" text,
	"public_reference" text,
	"last_carrier_status" text,
	"status" text DEFAULT 'label_created' NOT NULL,
	"shipped_at" timestamp with time zone,
	"estimated_delivery_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"last_event_description" text,
	"last_polled_at" timestamp with time zone,
	"customer_email" text,
	"customer_name" text,
	"destination_country" text,
	"internal_notes" text,
	"public_token_hash" text,
	"public_token_revoked_at" timestamp with time zone,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tracking_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"provider_event_id" text,
	"event_code" text NOT NULL,
	"normalized_status" text DEFAULT 'unknown' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"location_text" text,
	"event_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw_payload_redacted_json" jsonb,
	"is_customer_visible" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "audit_events_org_created_idx" ON "audit_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "background_jobs_claim_idx" ON "background_jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "background_jobs_idempotency_idx" ON "background_jobs" USING btree ("idempotency_key") WHERE "background_jobs"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "carrier_integrations_org_code_idx" ON "carrier_integrations" USING btree ("organization_id","carrier_code");--> statement-breakpoint
CREATE UNIQUE INDEX "carriers_org_code_idx" ON "carriers" USING btree ("organization_id","code");--> statement-breakpoint
CREATE INDEX "carriers_code_idx" ON "carriers" USING btree ("code");--> statement-breakpoint
CREATE INDEX "email_messages_org_status_idx" ON "email_messages" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "email_templates_org_type_idx" ON "email_templates" USING btree ("organization_id","type");--> statement-breakpoint
CREATE INDEX "exception_comments_exception_idx" ON "exception_comments" USING btree ("exception_id","created_at");--> statement-breakpoint
CREATE INDEX "import_row_errors_import_idx" ON "import_row_errors" USING btree ("import_id","row_number");--> statement-breakpoint
CREATE INDEX "imports_org_idx" ON "imports" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "integration_sync_runs_org_idx" ON "integration_sync_runs" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_hash_idx" ON "invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_org_user_idx" ON "memberships" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_logs_idempotency_idx" ON "notification_logs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "notification_logs_org_status_idx" ON "notification_logs" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "notification_logs_shipment_idx" ON "notification_logs" USING btree ("shipment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_rules_org_event_idx" ON "notification_rules" USING btree ("organization_id","event_type");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_idx" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "password_reset_token_hash_idx" ON "password_reset_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_idx" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "shipment_exceptions_org_status_idx" ON "shipment_exceptions" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "shipment_exceptions_shipment_idx" ON "shipment_exceptions" USING btree ("shipment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_org_carrier_tracking_idx" ON "shipments" USING btree ("organization_id","carrier_code","tracking_number");--> statement-breakpoint
CREATE INDEX "shipments_org_status_idx" ON "shipments" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "shipments_org_last_event_idx" ON "shipments" USING btree ("organization_id","last_event_at");--> statement-breakpoint
CREATE INDEX "shipments_tracking_number_idx" ON "shipments" USING btree ("tracking_number");--> statement-breakpoint
CREATE INDEX "shipments_public_token_idx" ON "shipments" USING btree ("public_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "tracking_events_provider_identity_idx" ON "tracking_events" USING btree ("organization_id","provider_event_id") WHERE "tracking_events"."provider_event_id" is not null;--> statement-breakpoint
CREATE INDEX "tracking_events_shipment_event_idx" ON "tracking_events" USING btree ("shipment_id","event_at");--> statement-breakpoint
CREATE INDEX "tracking_events_org_received_idx" ON "tracking_events" USING btree ("organization_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");