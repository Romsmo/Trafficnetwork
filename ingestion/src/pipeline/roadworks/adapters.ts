import type { Logger } from "../../logging.js";
import { normalizeAutobahnRoadworks } from "./autobahn-de.js";
import { parseDatex2 } from "./datex2.js";
import type { FeedConfig } from "./feeds.js";
import { bodyChunks, politeGet, type HttpOptions } from "./fetch.js";
import type { ParseResult } from "./types.js";

/** Turns one configured feed into a ParseResult (fetch + parse). Throws when the feed cannot be read at all. */
export type FeedAdapter = (feed: FeedConfig) => Promise<ParseResult>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function defaultAdapters(http: HttpOptions, logger: Logger): Record<FeedConfig["kind"], FeedAdapter> {
  return {
    datex2: async (feed) => parseDatex2(bodyChunks(await politeGet(feed.url, http, logger))),

    "autobahn-de-json": async (feed) => {
      // One request lists the roads, then one per road. The run is complete only if EVERY request succeeded: one failed road
      // means its roadworks are missing from this run, and retiring "what was not seen" would then wrongly end them.
      const base = feed.url.endsWith("/") ? feed.url : `${feed.url}/`;
      const roadsBody = (await (await politeGet(base, http, logger)).json()) as { roads?: unknown };
      const roads = Array.isArray(roadsBody.roads) ? roadsBody.roads.filter((r): r is string => typeof r === "string") : [];
      if (roads.length === 0) throw new Error(`the road list of ${base} was empty or not in the expected shape`);

      const perRoad: { road: string; roadworks: unknown[] }[] = [];
      const failures: string[] = [];
      for (const road of roads) {
        try {
          const body = (await (await politeGet(`${base}${encodeURIComponent(road)}/services/roadworks`, http, logger)).json()) as { roadworks?: unknown };
          perRoad.push({ road, roadworks: Array.isArray(body.roadworks) ? body.roadworks : [] });
        } catch (err) {
          failures.push(`${road}: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (feed.requestDelayMs) await sleep(feed.requestDelayMs);
      }
      if (failures.length > 0) logger.warn({ feed: feed.id, failures }, "some roads could not be fetched — this run will not retire anything");
      return normalizeAutobahnRoadworks(perRoad, failures.length === 0, failures.length > 0 ? `${failures.length} of ${roads.length} road requests failed` : undefined);
    },
  };
}
