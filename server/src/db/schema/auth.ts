import { type AnyPgColumn, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
  /**
   * Set only for device credentials minted via POST /v1/devices/register
   * (client-lib P2.0) — points at the app-key client that registered them, so
   * an app's devices can be looked up/rate-limited by app key. Null for every
   * client provisioned directly via create-client.
   */
  registeredByClientId: uuid("registered_by_client_id").references((): AnyPgColumn => clients.id),
  /**
   * Ed25519 public key (raw base64url — see modules/crypto/keys.ts), set once
   * a client has bound a device-generated key via POST /v1/devices/bind-key
   * (F-S2, additive — see docs/threat-model.md's migration path). When set,
   * the client may also authenticate via POST /v1/auth/device-token (a
   * signed assertion) instead of the symmetric clientSecret — the point of
   * federation's asymmetric device identity (docs/federation.md section 2):
   * a server that never saw this client's secret can still verify a
   * signature against this public key. Null for every client that hasn't
   * bound a key yet — the symmetric clientSecret flow keeps working
   * unchanged either way.
   */
  devicePublicKey: text("device_public_key"),
});
