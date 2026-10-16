/**
 * Place search for the web page: "where is Postau?" (docs/place-search.md).
 *
 * The node asks a Nominatim-compatible geocoder (https://nominatim.org/release-docs/latest/api/Search/; data © OpenStreetMap
 * contributors, ODbL) on the visitor's behalf. It is the *node* that talks to the service, not the visitor's browser: the service
 * never sees a visitor's address, the page needs no new connection (its Content-Security-Policy stays as it is), and the usage
 * policy of the public instance (https://operations.osmfoundation.org/policies/nominatim/) can be kept in one place:
 *
 *  - at most one request per second to the service (a queue, `PLACE_SEARCH_MIN_INTERVAL_MS`),
 *  - an identifying User-Agent,
 *  - answers are cached (in memory only: a search term can be an address, so nothing is written to disk or logged),
 *  - no "search as you type" - the page searches when the visitor asks it to.
 */

export type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface Place {
  /** Stable within the service's answer (`<osm type><osm id>`, else its place id). */
  id: string;
  /** What the place is called: "Postau", "Hauptstraße 1". */
  name: string;
  /** The full line the service gives: "Postau, Landkreis Landshut, Bayern, Deutschland". */
  label: string;
  lat: number;
  lng: number;
  /** The service's own kind of place (`city`, `residential`, …), when it says one. */
  kind: string | null;
  /** [west, south, east, north], to fit the map to the place. */
  bbox: [number, number, number, number] | null;
}

const MAX_LABEL = 240;

function num(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n : null;
}

/** The places of a Nominatim `jsonv2` answer; anything that is not a usable place is left out. */
export function parsePlaces(answer: unknown, max: number): Place[] {
  if (!Array.isArray(answer)) return [];
  const seen = new Set<string>();
  const places: Place[] = [];
  for (const raw of answer) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const lat = num(item.lat);
    const lng = num(item.lon);
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const label = typeof item.display_name === "string" ? item.display_name.trim().slice(0, MAX_LABEL) : "";
    if (label === "") continue;
    const named = typeof item.name === "string" && item.name.trim() !== "" ? item.name.trim() : label.split(",")[0]!.trim();
    const osmType = typeof item.osm_type === "string" ? item.osm_type.charAt(0) : "";
    const id = item.osm_id !== undefined && osmType !== "" ? `${osmType}${String(item.osm_id)}` : `p${String(item.place_id ?? places.length)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    let bbox: Place["bbox"] = null;
    if (Array.isArray(item.boundingbox) && item.boundingbox.length === 4) {
      // Nominatim: [south, north, west, east]
      const box = item.boundingbox.map(num);
      const [south, north, west, east] = box;
      if (box.every((n) => n !== null) && south! <= north! && west! <= east!) bbox = [west!, south!, east!, north!];
    }
    const kind = typeof item.type === "string" && item.type !== "" ? item.type.slice(0, 40) : null;
    places.push({ id, name: named.slice(0, 120), label, lat, lng, kind, bbox });
    if (places.length >= max) break;
  }
  return places;
}

export interface PlaceSearchOptions {
  /** The geocoder's search endpoint, e.g. https://nominatim.openstreetmap.org/search */
  url: string;
  userAgent: string;
  timeoutMs: number;
  /** Least time between two requests to the service. */
  minIntervalMs: number;
  cacheTtlMs: number;
  maxResults?: number;
  fetcher?: Fetcher;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SearchInput {
  q: string;
  /** Where the visitor is looking (rounded): results near it rank first. Not a restriction. */
  near?: { lat: number; lng: number };
  lang?: "de" | "en";
}

export class PlaceSearchError extends Error {}

const CACHE_MAX = 500;

/** A search function with its own queue and cache. One per node. */
export function createPlaceSearch(options: PlaceSearchOptions): (input: SearchInput) => Promise<Place[]> {
  const fetcher: Fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxResults = options.maxResults ?? 6;
  const cache = new Map<string, { at: number; places: Place[] }>();
  const inflight = new Map<string, Promise<Place[]>>();
  let queue: Promise<unknown> = Promise.resolve();
  let lastRequestAt = 0;

  const keyOf = (input: SearchInput): string => {
    const near = input.near ? `${input.near.lat.toFixed(1)},${input.near.lng.toFixed(1)}` : "-";
    return `${input.lang ?? "-"}|${near}|${input.q.trim().toLowerCase().replace(/\s+/g, " ")}`;
  };

  const requestUrl = (input: SearchInput): string => {
    const params = new URLSearchParams({ q: input.q.trim(), format: "jsonv2", limit: String(maxResults + 2), addressdetails: "0", dedupe: "1" });
    params.set("accept-language", input.lang === "en" ? "en,de" : "de,en");
    if (input.near) {
      // A soft preference for what lies around the map (about 1 degree wide), never a limit ("bounded" stays off).
      const d = 0.5;
      params.set("viewbox", [input.near.lng - d, input.near.lat + d, input.near.lng + d, input.near.lat - d].map((n) => n.toFixed(4)).join(","));
    }
    return `${options.url}${options.url.includes("?") ? "&" : "?"}${params.toString()}`;
  };

  const ask = async (input: SearchInput): Promise<Place[]> => {
    // one request at a time, never closer together than the service's policy allows
    const turn = queue.then(async () => {
      const wait = lastRequestAt + options.minIntervalMs - now();
      if (wait > 0) await sleep(wait);
      lastRequestAt = now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      try {
        const response = await fetcher(requestUrl(input), { headers: { "user-agent": options.userAgent, accept: "application/json" }, signal: controller.signal });
        if (!response.ok) throw new PlaceSearchError(`the place service answered HTTP ${response.status}`);
        return parsePlaces(await response.json(), maxResults);
      } catch (error) {
        if (error instanceof PlaceSearchError) throw error;
        throw new PlaceSearchError(error instanceof Error && error.name === "AbortError" ? "the place service did not answer in time" : "the place service could not be reached");
      } finally {
        clearTimeout(timer);
      }
    });
    queue = turn.catch(() => undefined);
    return turn;
  };

  return async (input) => {
    const key = keyOf(input);
    const hit = cache.get(key);
    if (hit && now() - hit.at < options.cacheTtlMs) return hit.places;
    const running = inflight.get(key);
    if (running) return running;
    const promise = ask(input)
      .then((places) => {
        // an empty answer is cached as well: asking again would not change it, and the service is not to be hammered
        cache.set(key, { at: now(), places });
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
        return places;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  };
}
