import type { ActiveRoadwork, RoadworkCandidate } from "./types.js";

/**
 * Which candidates the server should hear about right now, and until when.
 *
 * The server stores one expiry per report and the importer runs periodically, so the rule is deliberately simple and errs
 * towards NOT showing a roadwork that is not there:
 *  - explicit windows (night works etc.): active only while a window runs (or starts within `lookaheadMs`); the report expires at that
 *    window's end, and a later run brings the next window;
 *  - overall start/end: active from `start` (minus the lookahead) until `end`;
 *  - no times at all: active, and the server's ttl (renewed on every sighting) applies.
 * A roadwork whose start is further away than the lookahead is simply not sent yet — the next poll after it starts picks it up.
 */
export type Selection = { active: ActiveRoadwork } | { skip: string };

export function selectActive(candidate: RoadworkCandidate, now: Date, lookaheadMs: number): Selection {
  const horizon = now.getTime() + lookaheadMs;
  const { start, end, windows } = candidate.validity;
  const base = { externalId: candidate.externalId, lat: candidate.lat, lng: candidate.lng, caveat: candidate.caveat };

  if (windows && windows.length > 0) {
    const running = windows
      .filter((w) => w.start.getTime() <= horizon && w.end.getTime() > now.getTime())
      .sort((a, b) => a.end.getTime() - b.end.getTime())[0];
    if (running) return { active: { ...base, endsAt: running.end, intervalStart: running.start, intervalEnd: running.end } };
    const last = Math.max(...windows.map((w) => w.end.getTime()));
    return { skip: last <= now.getTime() ? "all validity windows are over" : "no validity window is running now" };
  }

  if (start && start.getTime() > horizon) return { skip: "starts later" };
  if (end && end.getTime() <= now.getTime()) return { skip: "already ended" };
  return { active: { ...base, endsAt: end, intervalStart: start, intervalEnd: end } };
}

const EARTH_RADIUS_M = 6_371_000;

export function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(bLat - aLat) / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(rad(bLng - aLng) / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function intervalsOverlap(a: ActiveRoadwork, b: ActiveRoadwork): boolean {
  const aStart = a.intervalStart?.getTime() ?? -Infinity;
  const aEnd = a.intervalEnd?.getTime() ?? Infinity;
  const bStart = b.intervalStart?.getTime() ?? -Infinity;
  const bEnd = b.intervalEnd?.getTime() ?? Infinity;
  return aStart <= bEnd && bStart <= aEnd;
}

export interface FeedSelection {
  feedId: string;
  active: ActiveRoadwork[];
}

export interface CrossFeedResult {
  /** Per feed: what remains after removing what a higher-priority feed already covers. */
  kept: Map<string, ActiveRoadwork[]>;
  /** Per feed: how many of its roadworks were left out because another feed already describes the same one. */
  mergedAway: Map<string, number>;
}

/**
 * The same roadwork can be published by two feeds (e.g. a national access point and an operator's own API). It must not be
 * created twice. Feeds are given in priority order (the configuration order): a roadwork of a lower-priority feed is left out
 * when a higher-priority feed has one within `radiusMeters` whose time interval overlaps. Roadworks of the SAME feed are never
 * merged with each other — two works close together on one motorway are two works.
 *
 * Only what is in this run is compared. If the higher-priority feed failed to load, its roadworks are absent here and the lower feed
 * keeps its own — and because rows of a lower feed that were left out are simply not re-sent, its next complete run retires them.
 */
export function mergeAcrossFeeds(feeds: FeedSelection[], radiusMeters: number): CrossFeedResult {
  const kept = new Map<string, ActiveRoadwork[]>();
  const mergedAway = new Map<string, number>();
  const accepted: ActiveRoadwork[] = [];

  for (const feed of feeds) {
    const own: ActiveRoadwork[] = [];
    let dropped = 0;
    for (const roadwork of feed.active) {
      const duplicate = accepted.some((other) => distanceMeters(other.lat, other.lng, roadwork.lat, roadwork.lng) <= radiusMeters && intervalsOverlap(other, roadwork));
      if (duplicate) dropped++;
      else own.push(roadwork);
    }
    accepted.push(...own);
    kept.set(feed.feedId, own);
    mergedAway.set(feed.feedId, dropped);
  }
  return { kept, mergedAway };
}
