ALTER TABLE "hazard_reports" ADD COLUMN "source_feed" text;--> statement-breakpoint
ALTER TABLE "hazard_reports" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "hazard_reports" ADD COLUMN "last_seen_run" text;--> statement-breakpoint
-- lock-ok(hazard_reports): a partial unique index over two new, still-null columns blocks writes to
-- hazard_reports while it builds. hazard_reports holds user reports, not bulk-imported static data, so it
-- is orders of magnitude smaller than speed_limit_segments (see "Migrations that take a heavy lock" in
-- docs/operating.md) — expected to be sub-second even on a busy node.
CREATE UNIQUE INDEX "hazard_reports_seed_identity_uq" ON "hazard_reports" USING btree ("source_feed","external_id") WHERE "hazard_reports"."source_feed" is not null;