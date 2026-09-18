CREATE TYPE "public"."peer_discovery_source" AS ENUM('seed', 'gossip', 'join');--> statement-breakpoint
CREATE TABLE "network_peers" (
	"node_id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"address" text NOT NULL,
	"discovered_via" "peer_discovery_source" NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_pulled_sequence" integer
);
--> statement-breakpoint
ALTER TABLE "event_log" ADD COLUMN "federation_event_id" text;--> statement-breakpoint
ALTER TABLE "event_log" ADD COLUMN "federation_envelope" jsonb;--> statement-breakpoint
ALTER TABLE "event_log" ADD COLUMN "origin_node_id" text;--> statement-breakpoint
CREATE INDEX "event_log_federation_event_id_idx" ON "event_log" USING btree ("federation_event_id");--> statement-breakpoint
ALTER TABLE "event_log" ADD CONSTRAINT "event_log_federation_event_id_unique" UNIQUE("federation_event_id");