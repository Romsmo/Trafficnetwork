import type { FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import { z } from "zod";
import { verifyToken } from "../auth/jwt.js";
import { expandTile } from "../../lib/h3.js";
import { SubscriptionRegistry } from "./registry.js";
import { zoneStates } from "../cameras/policy/delivery.js";
import { isWebSessionSubject } from "../web/guard.js";

const AUTH_TIMEOUT_MS = 10_000;

const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth"), token: z.string() }),
  z.object({ type: z.literal("subscribe"), tile: z.string(), k: z.number().int().min(0).max(5).optional() }),
  z.object({ type: z.literal("unsubscribe"), tile: z.string(), k: z.number().int().min(0).max(5).optional() }),
]);

/**
 * Auth happens via the first message after connect, not a query-string token —
 * query strings end up in access logs and proxies, which a bearer credential
 * shouldn't (see work order "phase1-server" (kept outside the repo) section 5.5 / the plan's auth
 * section). Anything else sent before a successful "auth" message is ignored.
 * A connection that never authenticates within AUTH_TIMEOUT_MS is closed.
 */
export async function registerRealtimeModule(app: FastifyInstance): Promise<SubscriptionRegistry> {
  const registry = new SubscriptionRegistry({
    current: () => app.cameraPolicy.current(),
    regionTileResolution: app.deps.env.REGION_TILE_H3_RESOLUTION,
    zoneStates: (cells) => zoneStates(app.deps.db, app.cameraPolicy.current(), cells),
    onError: (err) => app.log.error({ err }, "camera zone push failed"),
  });
  await app.register(websocketPlugin);

  app.get("/v1/ws", { websocket: true }, (socket, req) => {
    let authenticated = false;
    // Anonymous web sessions are free to mint, so they get a cap on subscribed tiles (see modules/web).
    let webSession = false;

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
            const claims = await verifyToken(parsed.token, app.deps.env);
            // The socket can close while the token is being verified; its "close"
            // event has already fired by then, so registering it now would leave
            // a connection nothing ever removes (and the online counter would
            // count a client that is long gone).
            if (socket.readyState !== socket.OPEN) return;
            webSession = app.deps.env.WEB_UI_ENABLED && isWebSessionSubject(claims.sub);
            authenticated = true;
            clearTimeout(authTimer);
            registry.addConnection(socket, { webSession });
            app.online.wsConnected(socket, claims);
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
          if (parsed.type === "subscribe") {
            if (webSession && registry.tileCountWith(socket, tiles) > app.deps.env.WEB_WS_MAX_TILES_PER_CONNECTION) {
              socket.send(JSON.stringify({ type: "error", message: "Too many subscribed tiles for a web session" }));
              return;
            }
            registry.subscribe(socket, tiles);
          } else {
            registry.unsubscribe(socket, tiles);
          }
        } catch {
          socket.send(JSON.stringify({ type: "error", message: "Invalid tile" }));
        }
      })().catch((err: unknown) => req.log.error(err, "unhandled error in WebSocket message handler"));
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      registry.removeConnection(socket);
      app.online.wsDisconnected(socket);
    });

    req.log.debug("WebSocket connection opened, awaiting auth");
  });

  return registry;
}
