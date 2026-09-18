ALTER TABLE "network_peers" ADD COLUMN "successful_health_checks" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "network_peers" ADD COLUMN "consecutive_health_check_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "network_peers" ADD COLUMN "invalid_signature_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "network_peers" ADD COLUMN "last_known_version" text;