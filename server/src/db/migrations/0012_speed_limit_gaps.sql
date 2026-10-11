-- Community speed limits for roads the import has none for (docs/speed-limit-corrections.md D13).
--
-- Additive only: one new enum label and one new, empty table. speed_limit_segments is not touched (no rewrite, no
-- index, no lock): a community segment is an ordinary row of it, written by the application when a value is applied.
-- lock-trivial: a new label on an enum type is a catalog change, no table is rewritten or scanned
ALTER TYPE "public"."correction_reason" ADD VALUE 'missing';--> statement-breakpoint
CREATE TABLE "speed_limit_gaps" (
	"segment_key" text PRIMARY KEY NOT NULL,
	"cell" text NOT NULL,
	"axis" integer NOT NULL,
	"geometry" geometry(LineString,4326) NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
