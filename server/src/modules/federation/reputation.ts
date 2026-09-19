import type { Env } from "../../config/env.js";
import type { NetworkPeerApi } from "../../db/queries/network-peers.js";

export type ReputationTier = "probation" | "active" | "trusted";

/**
 * The F-S0 plan's decision 5: signals are things *this server itself
 * measured* about a peer (successful/failed active health checks, invalid
 * signatures observed in its pushes) — never anything the peer claims about
 * itself. Deliberately computed on read from the raw counters
 * (db/schema/network-peers.ts) rather than stored as its own column, so
 * there's exactly one source of truth and it can never drift out of sync
 * with the signals it summarizes.
 *
 * Exclusion (removing a peer from the network entirely) stays root-key-gated
 * (docs/threat-model.md) — nothing here can do that. Demotion only ever
 * moves a peer back to `probation`, never off this server's own peer list.
 */
export function computeReputationTier(peer: NetworkPeerApi, env: Env): ReputationTier {
  // Any invalid signature is treated as disqualifying on its own, per the
  // plan's "jede ungültige Signatur von S ist ein starkes Negativsignal" —
  // not a threshold to cross, immediate demotion to probation.
  if (peer.invalidSignatureCount > 0) return "probation";
  if (peer.consecutiveHealthCheckFailures >= env.REPUTATION_DEMOTE_AFTER_CONSECUTIVE_FAILURES) return "probation";

  const ageMs = Date.now() - Date.parse(peer.joinedAt);
  const ageHours = ageMs / (60 * 60_000);

  const meetsTrusted =
    ageHours >= env.REPUTATION_TRUSTED_MIN_HOURS && peer.successfulHealthChecks >= env.REPUTATION_TRUSTED_MIN_SUCCESSFUL_HEALTH_CHECKS;
  if (meetsTrusted) return "trusted";

  const meetsActive =
    ageHours >= env.REPUTATION_PROBATION_MIN_HOURS && peer.successfulHealthChecks >= env.REPUTATION_MIN_SUCCESSFUL_HEALTH_CHECKS;
  if (meetsActive) return "active";

  return "probation";
}

/**
 * Directory listing cap (F-S0 plan decision 5: "gedeckelter Verzeichnis-
 * Anteil für Probezeit-Server") — a new/unproven server is still
 * discoverable, just not able to dominate the list. `peers` should already
 * be in the order the caller wants ties broken (modules/network/routes.ts
 * sorts by joinedAt, oldest first, so the longest-probation entries are the
 * ones kept when the cap bites).
 */
export function applyDirectoryProbationCap<T extends { tier: ReputationTier }>(peers: T[], maxProbationShare: number): T[] {
  const nonProbation = peers.filter((p) => p.tier !== "probation");
  const probation = peers.filter((p) => p.tier === "probation");
  let maxProbationCount = Math.floor(peers.length * maxProbationShare);
  // Floor() rounds a lone probation peer's share down to 0 (e.g. 1 peer * 0.5
  // share), which would make a just-joined server on an otherwise-empty
  // network permanently undiscoverable — the opposite of "still discoverable,
  // just not able to dominate the list" above. Only rescue that specific
  // case: an operator who explicitly zeroes the share out is still obeyed.
  if (maxProbationCount === 0 && nonProbation.length === 0 && probation.length > 0 && maxProbationShare > 0) {
    maxProbationCount = 1;
  }
  return [...nonProbation, ...probation.slice(0, maxProbationCount)];
}
