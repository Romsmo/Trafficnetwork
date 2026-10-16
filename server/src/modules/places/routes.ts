import type { FastifyInstance } from "fastify";
import { ApiError, badRequest } from "../../lib/errors.js";
import { createPlaceSearch, PlaceSearchError } from "./search.js";

const MIN_QUERY = 2;
const MAX_QUERY = 120;

/**
 * `GET /v1/places/search?q=…[&lat=&lng=][&lang=de|en]` -> `{ places: Place[] }` (docs/place-search.md).
 * Registered only when PLACE_SEARCH_URL is not "none". Nothing about the request is stored or logged; the search term goes to
 * the place service (by the node, not by the visitor's browser) and an answer is kept in memory for PLACE_SEARCH_CACHE_SECONDS.
 */
export async function registerPlaceRoutes(app: FastifyInstance): Promise<void> {
  const env = app.deps.env;
  const search = createPlaceSearch({
    url: env.PLACE_SEARCH_URL,
    userAgent: `trafficnetwork-node (+${env.PROJECT_REPO_URL})`,
    timeoutMs: env.PLACE_SEARCH_TIMEOUT_MS,
    minIntervalMs: env.PLACE_SEARCH_MIN_INTERVAL_MS,
    cacheTtlMs: env.PLACE_SEARCH_CACHE_SECONDS * 1000,
  });

  app.get("/v1/places/search", async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const q = typeof query.q === "string" ? query.q.trim().replace(/\s+/g, " ") : "";
    if (q.length < MIN_QUERY || q.length > MAX_QUERY) throw badRequest(`q must be ${MIN_QUERY} to ${MAX_QUERY} characters`);

    let near: { lat: number; lng: number } | undefined;
    if (query.lat !== undefined || query.lng !== undefined) {
      const lat = Number(query.lat);
      const lng = Number(query.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw badRequest("lat and lng must be a position");
      near = { lat, lng };
    }
    const lang = query.lang === "en" ? "en" : query.lang === "de" ? "de" : undefined;

    // What a search term is must not end up in a shared cache of a proxy in front of the node.
    reply.header("cache-control", "no-store");
    try {
      return { places: await search({ q, ...(near ? { near } : {}), ...(lang ? { lang } : {}) }) };
    } catch (error) {
      if (error instanceof PlaceSearchError) throw new ApiError(502, "PLACE_SEARCH_UNAVAILABLE", error.message);
      throw error;
    }
  });
}
