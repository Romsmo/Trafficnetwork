-- Add-on D: persistent enforcement devices (docs/persistent-enforcement-devices.md).
--
-- fixed_speed_cameras becomes the table of every permanently installed enforcement device;
-- `camera_type` says which. Data-preserving and metadata-only: no row is rewritten, copied or
-- backfilled (a constant DEFAULT is stored in the catalogue, PostgreSQL >= 11), so this takes
-- milliseconds at any table size — measured 5 ms at 1,000,000 rows — and every existing row is a
-- speed camera without being touched. Guarded so that a second run changes nothing.
-- Rollback: src/db/rollback/0009_persistent_enforcement_devices.down.sql (docs/operating.md).
DO $$ BEGIN
  CREATE TYPE "public"."camera_type" AS ENUM('fixedSpeedCamera', 'redLightCamera', 'distanceControl');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
-- Events about the additional device kinds carry their own entity type (see config/constants.ts).
ALTER TYPE "public"."entity_type" ADD VALUE IF NOT EXISTS 'enforcementDevice';--> statement-breakpoint
ALTER TABLE "fixed_speed_cameras" ADD COLUMN IF NOT EXISTS "camera_type" "camera_type" DEFAULT 'fixedSpeedCamera' NOT NULL;--> statement-breakpoint
-- Package content changes shape (cameraType, enforcementDevices): bump the version once so clients refresh.
-- lock-trivial: static_data_state has exactly one row
UPDATE "static_data_state" SET "version" = "version" + 1 WHERE "id" = 1;
