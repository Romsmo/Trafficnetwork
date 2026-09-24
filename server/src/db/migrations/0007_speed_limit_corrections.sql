-- Community speed-limit corrections (add-on K-A, docs/speed-limit-corrections.md).
--
-- speed_limit_geometry_key(): the cross-server-stable identity of a segment's
-- geometry (see docs/schema.md for the formula). The PostGIS calls are bound to
-- the schema PostGIS is installed in via the function's own search_path, so the
-- expression keeps working under pg_restore (which empties search_path) and on
-- hosts that install PostGIS outside `public`.
DO $do$
DECLARE ns text;
BEGIN
  SELECT n.nspname INTO ns FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'postgis';
  IF ns IS NULL THEN
    RAISE EXCEPTION 'The postgis extension must be installed before migration 0007';
  END IF;
  EXECUTE format($fn$
    CREATE OR REPLACE FUNCTION speed_limit_geometry_key(geom %1$I.geometry) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    SET search_path = %1$I, pg_catalog
    AS $body$
      SELECT substr(encode(sha256(convert_to(least(q.fwd COLLATE "C", q.rev COLLATE "C"), 'UTF8')), 'hex'), 1, 32)
      FROM (
        SELECT string_agg(p.pt, ';' ORDER BY p.ord) AS fwd,
               string_agg(p.pt, ';' ORDER BY p.ord DESC) AS rev
        FROM (
          SELECT (round(ST_X(d.geom) * 10000000))::bigint::text || ',' || (round(ST_Y(d.geom) * 10000000))::bigint::text AS pt,
                 d.path[1] AS ord
          FROM ST_DumpPoints(geom) AS d
        ) p
      ) q
    $body$
  $fn$, ns);
END
$do$;
--> statement-breakpoint
CREATE TYPE "public"."correction_reason" AS ENUM('wrong_value', 'limit_lifted', 'sign_missing_or_new', 'other');--> statement-breakpoint
CREATE TYPE "public"."correction_status" AS ENUM('proposed', 'applied', 'superseded', 'reverted');--> statement-breakpoint
CREATE TYPE "public"."correction_vote_kind" AS ENUM('support', 'deny');--> statement-breakpoint
CREATE TABLE "speed_limit_correction_bans" (
	"reporter_id" text PRIMARY KEY NOT NULL,
	"reason" text,
	"banned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "speed_limit_correction_votes" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"segment_key" text NOT NULL,
	"reporter_id" text NOT NULL,
	"submitted_by" text,
	"kind" "correction_vote_kind" NOT NULL,
	"value" integer NOT NULL,
	"unit" "speed_limit_unit" NOT NULL,
	"reason" "correction_reason",
	"vote_timestamp" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"envelope" jsonb,
	"origin_node_id" text,
	CONSTRAINT "speed_limit_correction_votes_id_unique" UNIQUE("id")
);
--> statement-breakpoint
CREATE TABLE "speed_limit_corrections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"segment_key" text NOT NULL,
	"unit" "speed_limit_unit" NOT NULL,
	"value" integer NOT NULL,
	"reason" "correction_reason",
	"status" "correction_status" DEFAULT 'proposed' NOT NULL,
	"support_count" integer DEFAULT 0 NOT NULL,
	"deny_count" integer DEFAULT 0 NOT NULL,
	"first_proposed_at" timestamp with time zone NOT NULL,
	"last_vote_at" timestamp with time zone NOT NULL,
	"applied_at" timestamp with time zone,
	"reverted_at" timestamp with time zone,
	"base_value" integer,
	"blocked_at" timestamp with time zone,
	"blocked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "speed_limit_corrections_candidate_uq" UNIQUE("segment_key","unit","value")
);
--> statement-breakpoint
ALTER TABLE "speed_limit_segments" ADD COLUMN "geometry_key" text GENERATED ALWAYS AS (speed_limit_geometry_key(geometry)) STORED;--> statement-breakpoint
ALTER TABLE "static_data_state" ADD COLUMN "corrections_overlay_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "network_peers" ADD COLUMN "last_pulled_votes_sequence" integer;--> statement-breakpoint
CREATE INDEX "speed_limit_correction_votes_segment_idx" ON "speed_limit_correction_votes" USING btree ("segment_key");--> statement-breakpoint
CREATE INDEX "speed_limit_correction_votes_reporter_idx" ON "speed_limit_correction_votes" USING btree ("reporter_id");--> statement-breakpoint
CREATE INDEX "speed_limit_correction_votes_submitted_by_idx" ON "speed_limit_correction_votes" USING btree ("submitted_by","received_at");--> statement-breakpoint
CREATE INDEX "speed_limit_corrections_segment_idx" ON "speed_limit_corrections" USING btree ("segment_key");--> statement-breakpoint
CREATE INDEX "speed_limit_corrections_status_idx" ON "speed_limit_corrections" USING btree ("status");--> statement-breakpoint
CREATE INDEX "speed_limit_segments_geometry_key_idx" ON "speed_limit_segments" USING btree ("geometry_key");--> statement-breakpoint
-- Every segment now carries `segmentKey`, so the static packages change: bump the version once so clients refresh.
UPDATE "static_data_state" SET "version" = "version" + 1 WHERE "id" = 1;
