-- Join codes (docs/join-code.md): four nullable columns on clients, no default, no index. PostgreSQL records them in the catalog only;
-- no row is rewritten or scanned, existing clients and their tokens are untouched.
ALTER TABLE "clients" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "max_uses" integer;