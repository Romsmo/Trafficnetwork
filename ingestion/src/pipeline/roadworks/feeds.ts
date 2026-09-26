import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * The roadworks feed catalog (config/roadworks-feeds.json). Adding a country that publishes DATEX II is a new entry here —
 * not new code. Every entry names its license as the operator must record it (`sourceLicense` ends up on every imported row),
 * and a feed whose terms are not settled ships `enabled: false`: it runs only when the operator turns it on on purpose
 * (ROADWORKS_FEEDS_ON, or the source's own legacy switch named in `enabledByEnv`).
 */

const feedSchema = z.object({
  enabled: z.boolean(),
  /** Name of an existing boolean env flag that also enables this feed (kept so a source's older switch, e.g. AUTOBAHN_API_ENABLED, still means what it says). */
  enabledByEnv: z.string().optional(),
  kind: z.enum(["datex2", "autobahn-de-json"]),
  country: z.string().length(2),
  name: z.string().min(1),
  url: z.string().url(),
  /** Stored on every row; also decides how a reader of the data must credit it (see docs/attribution.md). */
  sourceLicense: z.string().min(1).max(200),
  attribution: z.string().min(1),
  /** No more than one fetch per feed within this many minutes — a misconfigured scheduler must not hammer a public feed. */
  minIntervalMinutes: z.number().int().positive(),
  /** A document older than this is treated as a feed that silently stopped: its content is used but it never retires anything. Default 24. */
  maxFeedAgeHours: z.number().positive().optional(),
  /** Lifetime of a roadwork without an end date, renewed on every sighting. Default: the server's construction band. */
  ttlHours: z.number().int().min(1).max(24 * 90).optional(),
  /** Autobahn API only: pause between the per-road requests (ms). */
  requestDelayMs: z.number().int().nonnegative().optional(),
  notes: z.string().optional(),
});

const feedsFileSchema = z.object({ feeds: z.record(z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).max(64), feedSchema) });

export type FeedConfig = z.infer<typeof feedSchema> & { id: string };

const DEFAULT_FEEDS_PATH = path.resolve(fileURLToPath(import.meta.url), "../../../../config/roadworks-feeds.json");

export function loadFeeds(filePath: string = DEFAULT_FEEDS_PATH): FeedConfig[] {
  const parsed = feedsFileSchema.safeParse(JSON.parse(readFileSync(filePath, "utf8")));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid roadworks feed config at ${filePath}:\n${issues}`);
  }
  // Object key order is the priority order for the cross-feed duplicate check (first = highest priority).
  return Object.entries(parsed.data.feeds).map(([id, feed]) => ({ id, ...feed }));
}

export interface FeedSwitches {
  /** Global kill switch. */
  roadworksEnabled: boolean;
  feedsOn: string[];
  feedsOff: string[];
  env: Record<string, string | undefined>;
}

/** Which feeds run: config `enabled`, the source's legacy env flag, and the operator's explicit on/off lists (off wins over everything). */
export function resolveEnabledFeeds(feeds: FeedConfig[], switches: FeedSwitches, only?: string[]): FeedConfig[] {
  if (!switches.roadworksEnabled) return [];
  const known = new Set(feeds.map((f) => f.id));
  for (const id of [...switches.feedsOn, ...switches.feedsOff, ...(only ?? [])]) {
    if (!known.has(id)) throw new Error(`Unknown roadworks feed "${id}" — known feeds: ${[...known].join(", ")}`);
  }
  return feeds.filter((feed) => {
    if (only && !only.includes(feed.id)) return false;
    if (switches.feedsOff.includes(feed.id)) return false;
    return feed.enabled || switches.feedsOn.includes(feed.id) || (feed.enabledByEnv !== undefined && switches.env[feed.enabledByEnv] === "true");
  });
}
