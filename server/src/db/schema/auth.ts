import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { clientScopeEnum } from "./enums.js";

/**
 * Client credentials, provisioned via scripts/create-client.mts (operator CLI, no
 * admin HTTP API in Phase 1 — see docs/prompt-phase1-server.md section 2 discussion
 * and the plan's "kein Admin-HTTP-API" decision). scopes is a simplified two-tier
 * model ("client" bundles read + report:write, "bulk-import" is granted
 * separately) rather than a finer read/report:write split, satisfying the prompt's
 * "mindestens: normaler Client, Bulk-Import-Client" minimum.
 */
export const clients = pgTable("clients", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: text("client_id").notNull().unique(),
  clientSecretHash: text("client_secret_hash").notNull(),
  scopes: clientScopeEnum("scopes").array().notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});
