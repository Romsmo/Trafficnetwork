-- Country-based camera policy (docs/camera-country-policy.md).
--
-- Everything here is additive and metadata-only on the existing tables: four nullable columns (no rewrite, no backfill —
-- NULL means "country not resolved", which the server treats as "not delivered"), two new, empty tables and one new
-- enum label. Boundary data is loaded by the operator (npm run cameras -- load-boundaries), never by a migration.
ALTER TYPE "public"."entity_type" ADD VALUE 'cameraZone';--> statement-breakpoint
CREATE TABLE "country_boundary_parts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"iso2" text NOT NULL,
	"geom" geometry(Polygon,4326) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "country_boundary_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"dataset" text,
	"features" integer,
	"loaded_at" timestamp with time zone,
	"margin_m" double precision,
	"content_hash" text
);
--> statement-breakpoint
ALTER TABLE "fixed_speed_cameras" ADD COLUMN "countries" text[];--> statement-breakpoint
ALTER TABLE "hazard_reports" ADD COLUMN "countries" text[];--> statement-breakpoint
ALTER TABLE "event_log" ADD COLUMN "camera_countries" text[];--> statement-breakpoint
ALTER TABLE "static_data_state" ADD COLUMN "camera_policy" jsonb;--> statement-breakpoint
ALTER TABLE "static_packages" ADD COLUMN "policy_stale" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "country_boundary_parts_geom_gist" ON "country_boundary_parts" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "country_boundary_parts_iso2_idx" ON "country_boundary_parts" USING btree ("iso2");
--> statement-breakpoint
-- camera_countries(point, margin_m): the country set of a camera — every country whose boundary is within margin_m of the
-- point (so: the country it is in, plus the neighbours inside the border strip). STABLE (reads country_boundary_parts).
-- The PostGIS calls are bound to the schema PostGIS is installed in via the function's own search_path, exactly like
-- speed_limit_geometry_key() in 0007, so the function survives pg_restore (which empties search_path).
-- The bbox predicate is only the index prefilter (a superset: longitude degrees per metre grow with latitude, so the
-- window is widened by 1/cos(lat), floored, plus 20 %); ST_DWithin on geography decides.
DO $do$
DECLARE ns text;
BEGIN
  SELECT n.nspname INTO ns FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'postgis';
  IF ns IS NULL THEN
    RAISE EXCEPTION 'The postgis extension must be installed before migration 0011';
  END IF;
  EXECUTE format($fn$
    CREATE OR REPLACE FUNCTION camera_countries(pt %1$I.geometry, margin_m double precision) RETURNS text[]
    LANGUAGE sql STABLE STRICT PARALLEL SAFE
    SET search_path = %1$I, pg_catalog
    AS $body$
      SELECT coalesce(array_agg(DISTINCT p.iso2 ORDER BY p.iso2), ARRAY[]::text[])
      FROM public.country_boundary_parts p
      WHERE p.geom && ST_Expand(pt, 0.0005 + 1.2 * margin_m / (111320.0 * greatest(cos(radians(abs(ST_Y(pt)))), 0.05)))
        AND ST_DWithin(p.geom::geography, pt::geography, margin_m)
    $body$
  $fn$, ns);
END
$do$;
--> statement-breakpoint
INSERT INTO "country_boundary_state" ("id") VALUES (1) ON CONFLICT DO NOTHING;
