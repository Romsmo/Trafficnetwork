CREATE TYPE "public"."camera_status" AS ENUM('active', 'removed');--> statement-breakpoint
CREATE TYPE "public"."client_scope" AS ENUM('client', 'bulk-import');--> statement-breakpoint
CREATE TYPE "public"."confirmation_kind" AS ENUM('stillThere', 'gone');--> statement-breakpoint
CREATE TYPE "public"."entity_type" AS ENUM('hazardReport', 'fixedSpeedCamera', 'speedLimitSegment', 'staticSign');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('ReportCreated', 'ReportConfirmed', 'ReportDenied', 'ReportExpired', 'StaticDataUpdated', 'StaticDataRemoved');--> statement-breakpoint
CREATE TYPE "public"."hazard_source" AS ENUM('community', 'seed');--> statement-breakpoint
CREATE TYPE "public"."hazard_status" AS ENUM('active', 'expired', 'removed');--> statement-breakpoint
CREATE TYPE "public"."hazard_type" AS ENUM('traffic', 'ice', 'accident', 'construction', 'breakdown', 'obstacle', 'fixedSpeedCamera', 'mobileSpeedCamera', 'trailerCamera', 'redLightCamera', 'distanceControl');--> statement-breakpoint
CREATE TYPE "public"."moderation_status" AS ENUM('accepted');--> statement-breakpoint
CREATE TYPE "public"."speed_limit_unit" AS ENUM('kmh', 'mph');--> statement-breakpoint
CREATE TABLE "speed_limit_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"geometry" geometry(LineString,4326) NOT NULL,
	"speed_limit" integer NOT NULL,
	"speed_limit_unit" "speed_limit_unit" NOT NULL,
	"source" text NOT NULL,
	"source_license" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "static_signs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" geometry(Point,4326) NOT NULL,
	"sign_type" text NOT NULL,
	"source" text NOT NULL,
	"source_license" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "camera_removal_reports" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"camera_id" uuid NOT NULL,
	"reporter_id" text NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "camera_removal_reports_camera_reporter_uq" UNIQUE("camera_id","reporter_id")
);
--> statement-breakpoint
CREATE TABLE "fixed_speed_cameras" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" geometry(Point,4326) NOT NULL,
	"status" "camera_status" DEFAULT 'active' NOT NULL,
	"removed_at" timestamp with time zone,
	"source" text NOT NULL,
	"source_license" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "hazard_confirmations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"hazard_report_id" uuid NOT NULL,
	"reporter_id" text NOT NULL,
	"confirmation" "confirmation_kind" NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hazard_confirmations_report_reporter_uq" UNIQUE("hazard_report_id","reporter_id")
);
--> statement-breakpoint
CREATE TABLE "hazard_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "hazard_type" NOT NULL,
	"position" geometry(Point,4326) NOT NULL,
	"region_tile" varchar(15) NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reporter_id" text NOT NULL,
	"speed_kmh" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "hazard_status" DEFAULT 'active' NOT NULL,
	"source" "hazard_source" DEFAULT 'community' NOT NULL,
	"source_license" text,
	"confirm_count" integer DEFAULT 0 NOT NULL,
	"deny_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_log" (
	"sequence" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"type" "event_type" NOT NULL,
	"entity_type" "entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"region_tile" varchar(15),
	"moderation_status" "moderation_status" DEFAULT 'accepted' NOT NULL,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_hash" text NOT NULL,
	"scopes" "client_scope"[] NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "clients_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
ALTER TABLE "camera_removal_reports" ADD CONSTRAINT "camera_removal_reports_camera_id_fixed_speed_cameras_id_fk" FOREIGN KEY ("camera_id") REFERENCES "public"."fixed_speed_cameras"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hazard_confirmations" ADD CONSTRAINT "hazard_confirmations_hazard_report_id_hazard_reports_id_fk" FOREIGN KEY ("hazard_report_id") REFERENCES "public"."hazard_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "speed_limit_segments_geometry_gist" ON "speed_limit_segments" USING gist ("geometry");--> statement-breakpoint
CREATE INDEX "static_signs_position_gist" ON "static_signs" USING gist ("position");--> statement-breakpoint
CREATE INDEX "fixed_speed_cameras_position_gist" ON "fixed_speed_cameras" USING gist ("position");--> statement-breakpoint
CREATE INDEX "hazard_reports_position_gist" ON "hazard_reports" USING gist ("position");--> statement-breakpoint
CREATE INDEX "hazard_reports_tile_status_idx" ON "hazard_reports" USING btree ("region_tile","status");--> statement-breakpoint
CREATE INDEX "hazard_reports_status_expires_idx" ON "hazard_reports" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "hazard_reports_type_idx" ON "hazard_reports" USING btree ("type");--> statement-breakpoint
CREATE INDEX "event_log_occurred_at_idx" ON "event_log" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "event_log_region_tile_idx" ON "event_log" USING btree ("region_tile");--> statement-breakpoint
CREATE INDEX "event_log_type_idx" ON "event_log" USING btree ("type");