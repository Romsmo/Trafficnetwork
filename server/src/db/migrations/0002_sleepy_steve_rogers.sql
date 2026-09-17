ALTER TYPE "public"."client_scope" ADD VALUE 'device-registration';--> statement-breakpoint
CREATE TABLE "static_data_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "registered_by_client_id" uuid;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_registered_by_client_id_clients_id_fk" FOREIGN KEY ("registered_by_client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO "static_data_state" ("id", "version") VALUES (1, 1) ON CONFLICT DO NOTHING;