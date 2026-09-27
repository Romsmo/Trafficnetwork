import type { Env } from "../../config/env.js";
import type { NetworkPeerApi } from "../../db/queries/network-peers.js";
import { computeReputationTier, type ReputationEnv, type ReputationTier } from "../federation/reputation.js";
import type { OnlineTracker } from "./tracker.js";

/**
 * One figure as the endpoint prints it. Under the threshold the exact number
 * is withheld: `online` is null and `below` says the threshold ("fewer than
 * `below`"). Exactly one of the two readings applies, never both.
 */
export type Figure = { online: number } | { online: null; below: number };

export type OnlineStatsResponse =
  | { enabled: false }
  | {
      enabled: true;
      node: Figure & { windowSeconds: number };
      /** Absent when this node does not federate (there is no network to estimate). */
      network?: Figure & { nodes: number; estimated: true; asOf: string };
      minDisplayThreshold: number;
    };

/** A count under `threshold` is not shown exactly — in a small network "1 online" is a statement about one person. threshold 0 never masks. */
export function applyThreshold(count: number, threshold: number): Figure {
  return count < threshold ? { online: null, below: threshold } : { online: count };
}

export interface PeerInput {
  tier: ReputationTier;
  /** In the signed network config's excludedNodeIds. */
  excluded: boolean;
  /** The peer's last figure from a signed heartbeat, or undefined if it never sent one or its heartbeat is stale. */
  reportedOnline: number | undefined;
}

/**
 * Own figure plus what other nodes claimed about themselves. Every peer figure
 * is a claim this server cannot check, so only peers this server has itself
 * measured as reliable (active or trusted — never probation) and heard from
 * recently count, and the result is always labelled an estimate.
 */
export function estimateNetwork(ownOnline: number, peers: PeerInput[]): { online: number; nodes: number } {
  let online = ownOnline;
  let nodes = 1;
  for (const peer of peers) {
    if (peer.excluded || peer.tier === "probation" || peer.reportedOnline === undefined) continue;
    online += peer.reportedOnline;
    nodes += 1;
  }
  return { online, nodes };
}

export interface StatsProviderDeps {
  env: Pick<Env, "ONLINE_COUNTER_ENABLED" | "ONLINE_MIN_DISPLAY_THRESHOLD" | "ONLINE_CACHE_SECONDS" | "FEDERATION_ENABLED"> & ReputationEnv;
  tracker: OnlineTracker;
  getPeers: () => Promise<NetworkPeerApi[]>;
  isExcluded: (nodeId: string) => boolean;
  /** Monotonic ms for the cache; wall-clock for `asOf`. Injectable for tests. */
  now?: () => number;
  wallClock?: () => Date;
}

/**
 * Builds the endpoint's answer, reusing one computed answer for
 * ONLINE_CACHE_SECONDS. Concurrent requests share a single computation, so a
 * burst of requests costs one peer-list query, not one each.
 */
export function createStatsProvider(deps: StatsProviderDeps): { get: () => Promise<OnlineStatsResponse> } {
  const { env, tracker } = deps;
  const now = deps.now ?? (() => performance.now());
  const wallClock = deps.wallClock ?? (() => new Date());
  const ttlMs = env.ONLINE_CACHE_SECONDS * 1000;

  let cached: { at: number; value: OnlineStatsResponse } | undefined;
  let inFlight: Promise<OnlineStatsResponse> | undefined;

  async function compute(): Promise<OnlineStatsResponse> {
    if (!env.ONLINE_COUNTER_ENABLED) return { enabled: false };

    const threshold = env.ONLINE_MIN_DISPLAY_THRESHOLD;
    const nodeOnline = tracker.nodeCount();
    const asOf = wallClock().toISOString();

    const response: Extract<OnlineStatsResponse, { enabled: true }> = {
      enabled: true,
      node: { ...applyThreshold(nodeOnline, threshold), windowSeconds: tracker.windowSeconds },
      minDisplayThreshold: threshold,
    };

    if (env.FEDERATION_ENABLED) {
      const peers = await deps.getPeers();
      const estimate = estimateNetwork(
        nodeOnline,
        peers.map((peer) => ({
          tier: computeReputationTier(peer, env),
          excluded: deps.isExcluded(peer.nodeId),
          reportedOnline: tracker.peerReport(peer.nodeId),
        })),
      );
      response.network = { ...applyThreshold(estimate.online, threshold), nodes: estimate.nodes, estimated: true, asOf };
    }
    return response;
  }

  return {
    get(): Promise<OnlineStatsResponse> {
      const t = now();
      if (cached && t - cached.at < ttlMs) return Promise.resolve(cached.value);
      inFlight ??= compute()
        .then((value) => {
          cached = { at: now(), value };
          return value;
        })
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
  };
}
