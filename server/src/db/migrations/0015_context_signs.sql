-- Context signs (docs/context-signs.md): traffic signs that apply on a stretch of road, entered and confirmed by users.
--
-- Additive only: four new tables (empty at the start - there is no import and no seed) and one nullable column on network_peers
-- (the cursor of the federation pull stream for the votes). Nothing existing is rewritten.
CREATE TABLE "context_sign_bans" (
	"reporter_id" text PRIMARY KEY NOT NULL,
	"reason" text,
	"banned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_sign_entries" (
	"entry_key" text PRIMARY KEY NOT NULL,
	"descriptor" jsonb NOT NULL,
	"sign_type" text NOT NULL,
	"sign_class" text NOT NULL,
	"geometry" geometry(LineString,4326) NOT NULL,
	"length_m" integer NOT NULL,
	"tiles" text[] NOT NULL,
	"tile_resolution" integer NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"support_count" integer DEFAULT 0 NOT NULL,
	"deny_count" integer DEFAULT 0 NOT NULL,
	"first_proposed_at" timestamp with time zone NOT NULL,
	"last_vote_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"last_confirmed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"blocked_at" timestamp with time zone,
	"blocked_reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_sign_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_sign_votes" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"entry_key" text NOT NULL,
	"reporter_id" text NOT NULL,
	"submitted_by" text,
	"kind" text NOT NULL,
	"vote_timestamp" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"envelope" jsonb,
	"origin_node_id" text,
	CONSTRAINT "context_sign_votes_id_unique" UNIQUE("id")
);
--> statement-breakpoint
ALTER TABLE "network_peers" ADD COLUMN "last_pulled_context_votes_sequence" integer;--> statement-breakpoint
CREATE INDEX "context_sign_entries_geometry_gist" ON "context_sign_entries" USING gist ("geometry");--> statement-breakpoint
CREATE INDEX "context_sign_entries_tiles_gin" ON "context_sign_entries" USING gin ("tiles");--> statement-breakpoint
CREATE INDEX "context_sign_entries_status_idx" ON "context_sign_entries" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "context_sign_entries_created_by_idx" ON "context_sign_entries" USING btree ("created_by","created_at");--> statement-breakpoint
CREATE INDEX "context_sign_votes_entry_idx" ON "context_sign_votes" USING btree ("entry_key");--> statement-breakpoint
CREATE INDEX "context_sign_votes_reporter_idx" ON "context_sign_votes" USING btree ("reporter_id");--> statement-breakpoint
CREATE INDEX "context_sign_votes_submitted_by_idx" ON "context_sign_votes" USING btree ("submitted_by","received_at");
--> statement-breakpoint
INSERT INTO "context_sign_state" ("id", "version") VALUES (1, 1) ON CONFLICT ("id") DO NOTHING;
