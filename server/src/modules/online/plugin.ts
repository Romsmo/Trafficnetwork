import type { FastifyInstance } from "fastify";
import { listPeers } from "../../db/queries/network-peers.js";
import { createStatsProvider } from "./stats.js";

/**
 * The requests that make a client count as online for the activity window
 * (besides an open WebSocket): the ones a client uses to keep its data in
 * sync, and the ones that contribute a report — so a client that only polls
 * is visible too. Matched by route pattern, so `:id` params don't matter.
 * Deliberately not: plain lookups, /v1/config, token exchange, anything a
 * service credential (bulk-import, device-registration) does — OnlineTracker
 * additionally only counts tokens carrying the `client` scope.
 */
const ACTIVITY_ROUTES: ReadonlySet<string> = new Set([
  "GET /v1/snapshot",
  "GET /v1/delta",
  "GET /v1/static-data/manifest",
  "GET /v1/static-data/partitions/:tile",
  "POST /v1/hazard-reports",
  "POST /v1/hazard-reports/:id/confirmations",
  "POST /v1/speed-cameras/:id/removal-reports",
]);

/**
 * Wires the "currently online" counter (add-on O-A): the activity hook and the
 * public GET /v1/stats/online. Needs app.online (the tracker, created in
 * app.ts so the WebSocket plugin and the federation module can reach it too)
 * and must be registered after the auth hook, whose result (req.auth) it reads.
 *
 * Counts on the way *out*, and only for requests that succeeded — a client
 * that is being rejected (bad request, rate-limited) isn't evidence of anyone
 * actually syncing, and this keeps a flood of junk requests from inflating
 * the number.
 */
export async function registerOnlineModule(app: FastifyInstance): Promise<void> {
  const { env } = app.deps;

  app.addHook("onResponse", async (req, reply) => {
    if (!req.auth || reply.statusCode >= 400) return;
    const pattern = req.routeOptions.url;
    if (pattern && ACTIVITY_ROUTES.has(`${req.method} ${pattern}`)) app.online.recordActivity(req.auth);
  });

  const stats = createStatsProvider({
    env,
    tracker: app.online,
    getPeers: () => listPeers(app.deps.db),
    isExcluded: (nodeId) => app.networkConfig?.payload.excludedNodeIds.includes(nodeId) ?? false,
  });

  // Public, no auth (see modules/auth/hook.ts PUBLIC_PATHS) and no per-route
  // rate limit — like node-info and the directory, the other public read
  // endpoints. What keeps it cheap is the cache: the answer is computed at
  // most once per ONLINE_CACHE_SECONDS however often it is asked for.
  app.get("/v1/stats/online", async (_req, reply) => {
    reply.header("Cache-Control", `public, max-age=${env.ONLINE_CACHE_SECONDS}`);
    return stats.get();
  });
}
