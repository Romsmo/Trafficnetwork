CREATE TABLE "static_package_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"fingerprint" text,
	"ready" boolean DEFAULT false NOT NULL,
	"built_version" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "static_packages" (
	"tile" text PRIMARY KEY NOT NULL,
	"hash" text,
	"size_bytes" bigint,
	"gzip_bytes" bigint,
	"brotli_bytes" bigint,
	"segment_count" integer,
	"sign_count" integer,
	"camera_count" integer,
	"built_for_version" integer,
	"built_at" timestamp with time zone,
	"dirty" boolean DEFAULT false NOT NULL,
	"dirty_version" integer,
	"dirty_marked_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "static_packages_dirty_idx" ON "static_packages" USING btree ("tile") WHERE dirty;--> statement-breakpoint
CREATE INDEX "static_packages_built_version_idx" ON "static_packages" USING btree ("built_for_version");--> statement-breakpoint
-- Add-on E-B: the single state row. `ready` is false, so the first request (small data) or the
-- package worker / `npm run static-packages -- build` (large data) performs the initial full build.
INSERT INTO "static_package_state" ("id") VALUES (1) ON CONFLICT DO NOTHING;