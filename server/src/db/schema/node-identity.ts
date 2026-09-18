import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Single-row table (id is always "self") holding this server's own Ed25519
 * node identity — generated on first boot (see modules/network/node-identity.ts),
 * never baked into a migration like static_data_state's seed row, since every
 * server instance must have its own unique keypair. Stored in the database
 * (same trust boundary as JWT_SECRET, clients.client_secret_hash, etc.) rather
 * than a file+volume — one less persistence mechanism to operate, and it
 * survives container recreation exactly as long as the database does, which
 * is already the durability guarantee everything else in this schema relies
 * on. This is the server's *own* identity, not a device signing key — the
 * "never leaves the device" rule in docs/threat-model.md applies to device
 * keys, not this one.
 */
export const nodeIdentity = pgTable("node_identity", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
