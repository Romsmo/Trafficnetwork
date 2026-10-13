-- Road network, attachment of items to roads, community intervals and defect reports (docs/road-network.md).
--
-- Additive only. New tables are empty. The columns added to speed_limit_segments, static_signs and fixed_speed_cameras have
-- constant defaults (true, 'pending') or none: PostgreSQL 11+ stores them in the catalog, nothing is rewritten and no index is
-- built on the big tables. Two columns of the empty-in-practice speed_limit_gaps lose NOT NULL.
CREATE TABLE "data_defect_removals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"target_type" text NOT NULL,
	"match_key" text NOT NULL,
	"reason" text,
	"removed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"restored_at" timestamp with time zone,
	CONSTRAINT "data_defect_removals_target_key_uq" UNIQUE("target_type","match_key")
);
--> statement-breakpoint
CREATE TABLE "data_defect_reports" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"reporter_id" text NOT NULL,
	"reason" text,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_defect_reports_target_reporter_uq" UNIQUE("target_type","target_id","reporter_id")
);
--> statement-breakpoint
CREATE TABLE "road_coverage_tiles" (
	"tile" text PRIMARY KEY NOT NULL,
	"via" text NOT NULL,
	"way_count" integer DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "road_ways" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"geometry" geometry(LineString,4326) NOT NULL,
	"highway" text NOT NULL,
	"name" text,
	"ref" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "road_ways_source_external_uq" UNIQUE("source","external_id")
);
--> statement-breakpoint
CREATE TABLE "speed_limit_splits" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"interval_key" text NOT NULL,
	"original_id" uuid NOT NULL,
	"piece_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "speed_limit_gaps" ALTER COLUMN "cell" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "speed_limit_gaps" ALTER COLUMN "axis" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "speed_limit_segments" ADD COLUMN "visible" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "speed_limit_segments" ADD COLUMN "hidden_reason" text;--> statement-breakpoint
ALTER TABLE "static_signs" ADD COLUMN "road_source" text;--> statement-breakpoint
ALTER TABLE "static_signs" ADD COLUMN "road_id" uuid;--> statement-breakpoint
ALTER TABLE "static_signs" ADD COLUMN "road_offset_m" double precision;--> statement-breakpoint
ALTER TABLE "static_signs" ADD COLUMN "attach_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "static_signs" ADD COLUMN "visible" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "static_signs" ADD COLUMN "hidden_reason" text;--> statement-breakpoint
ALTER TABLE "fixed_speed_cameras" ADD COLUMN "road_source" text;--> statement-breakpoint
ALTER TABLE "fixed_speed_cameras" ADD COLUMN "road_id" uuid;--> statement-breakpoint
ALTER TABLE "fixed_speed_cameras" ADD COLUMN "road_offset_m" double precision;--> statement-breakpoint
ALTER TABLE "fixed_speed_cameras" ADD COLUMN "attach_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "fixed_speed_cameras" ADD COLUMN "visible" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "fixed_speed_cameras" ADD COLUMN "hidden_reason" text;--> statement-breakpoint
ALTER TABLE "speed_limit_gaps" ADD COLUMN "ref" text;--> statement-breakpoint
ALTER TABLE "speed_limit_gaps" ADD COLUMN "road_name" text;--> statement-breakpoint
ALTER TABLE "speed_limit_gaps" ADD COLUMN "road_ref" text;--> statement-breakpoint
ALTER TABLE "speed_limit_gaps" ADD COLUMN "road_class" text;--> statement-breakpoint
ALTER TABLE "speed_limit_gaps" ADD COLUMN "length_m" integer;--> statement-breakpoint
ALTER TABLE "speed_limit_gaps" ADD COLUMN "checked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "data_defect_reports_target_idx" ON "data_defect_reports" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "road_ways_geometry_gist" ON "road_ways" USING gist ("geometry");--> statement-breakpoint
CREATE INDEX "speed_limit_splits_interval_idx" ON "speed_limit_splits" USING btree ("interval_key");