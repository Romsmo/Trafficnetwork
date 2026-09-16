import type { FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import { z } from "zod";
import { verifyToken } from "../auth/jwt.js";
import { expandTile } from "../../lib/h3.js";
import { SubscriptionRegistry } from "./registry.js";

const AUTH_TIMEOUT_MS = 10_000;

const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth"), token: z.string() }),
  z.object({ type: z.literal("subscribe"), tile: z.string(), k: z.number().int().min(0).max(5).optional() }),
  z.object({ type: z.literal("unsubscribe"), tile: z.string(), k: z.number().int().min(0).max(5).optional() }),
]);

/**
 * Auth happens via the first message after connect, not a query-string token —
 * query strings end up in access logs and proxies, which a bearer credential
 * shouldn't (see docs/prompt-phase1-server.md section 5.5 / the plan's auth
 * section). Anything else sent before a successful "auth" message is ignored.
 * A connection that never authenticates within AUTH_TIMEOUT_MS is closed.
 */
export async function registerRealtimeModule(app: FastifyInstance): Promise<SubscriptionRegistry> {
  const registry = new SubscriptionRegistry();
  await app.register(websocketPlugin);

  app.get("/v1/ws", { websocket: true }, (socket, req) => {
    let authenticated = false;

    const authTimer = setTimeout(() => {
      if (!authenticated) socket.close(4001, "Authentication timeout");
    }, AUTH_TIMEOUT_MS);

    socket.on("message", (raw: Buffer) => {
      void (async () => {
        let parsed: z.infer<typeof clientMessageSchema>;
        try {
          parsed = clientMessageSchema.parse(JSON.parse(raw.toString()));
        } catch {
          socket.send(JSON.stringify({ type: "error", message: "Malformed message" }));
          return;
        }

        if (parsed.type === "auth") {
          try {
            await verifyToken(parsed.token, app.deps.env);
            authenticated = true;
            clearTimeout(authTimer);
            registry.addConnection(socket);
            socket.send(JSON.stringify({ type: "auth_ok" }));
          } catch {
            socket.send(JSON.stringify({ type: "error", message: "Invalid token" }));
            socket.close(4001, "Invalid token");
          }
          return;
        }

        if (!authenticated) {
          socket.send(JSON.stringify({ type: "error", message: "Not authenticated" }));
          return;
        }

        try {
          const tiles = expandTile(parsed.tile, parsed.k ?? 0);
          if (parsed.type === "subscribe") registry.subscribe(socket, tiles);
          else registry.unsubscribe(socket, tiles);
        } catch {
          socket.send(JSON.stringify({ type: "error", message: "Invalid tile" }));
        }
      })().catch((err: unknown) => req.log.error(err, "unhandled error in WebSocket message handler"));
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      registry.removeConnection(socket);
    });

    req.log.debug("WebSocket connection opened, awaiting auth");
  });

  return registry;
}
