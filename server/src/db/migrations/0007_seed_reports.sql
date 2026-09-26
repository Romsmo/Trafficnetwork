ALTER TABLE "hazard_reports" ADD COLUMN "source_feed" text;--> statement-breakpoint
ALTER TABLE "hazard_reports" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "hazard_reports" ADD COLUMN "last_seen_run" text;--> statement-breakpoint
CREATE UNIQUE INDEX "hazard_reports_seed_identity_uq" ON "hazard_reports" USING btree ("source_feed","external_id") WHERE "hazard_reports"."source_feed" is not null;