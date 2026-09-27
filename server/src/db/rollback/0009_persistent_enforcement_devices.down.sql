-- Rollback of migration 0009 (add-on D, persistent enforcement devices).
--
-- Run by hand, after taking a backup and stopping the server (docs/operating.md, "Rolling back 0009"):
--   psql -v ON_ERROR_STOP=1 -f src/db/rollback/0009_persistent_enforcement_devices.down.sql "$DATABASE_URL"
--
-- All in one transaction; a second run changes nothing. It refuses — and changes nothing — while
-- rows of the additional device kinds exist: dropping `camera_type` would turn every red-light and
-- distance device into a speed camera, and this script never reclassifies data silently. Export or
-- delete those rows on purpose, then run it again:
--   \copy (select * from fixed_speed_cameras where camera_type <> 'fixedSpeedCamera') to 'devices.csv' csv header
--   delete from fixed_speed_cameras where camera_type <> 'fixedSpeedCamera';
--
-- Not undone: the label 'enforcementDevice' added to the `entity_type` enum (PostgreSQL cannot drop
-- an enum label; nothing writes it after the rollback, so it is harmless).
BEGIN;

DO $$
DECLARE
  extra bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'fixed_speed_cameras' AND column_name = 'camera_type'
  ) THEN
    EXECUTE 'SELECT count(*) FROM "fixed_speed_cameras" WHERE "camera_type" <> ''fixedSpeedCamera''' INTO extra;
    IF extra > 0 THEN
      RAISE EXCEPTION 'Rollback refused: % row(s) in fixed_speed_cameras are red-light or distance devices. Dropping camera_type would turn them into speed cameras. Export or delete them first (see the header of this file).', extra;
    END IF;
  END IF;
END $$;

ALTER TABLE "fixed_speed_cameras" DROP COLUMN IF EXISTS "camera_type";
DROP TYPE IF EXISTS "public"."camera_type";

-- Without this the next start of the new code would believe 0009 is applied and find the column missing.
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1790433506774;

-- Package content changes shape back: bump the version once so clients refresh.
UPDATE "static_data_state" SET "version" = "version" + 1 WHERE "id" = 1;

COMMIT;
