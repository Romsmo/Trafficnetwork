import { pgEnum } from "drizzle-orm/pg-core";
import {
  CLIENT_SCOPES,
  CORRECTION_REASONS,
  CORRECTION_STATUSES,
  CORRECTION_VOTE_KINDS,
  ENTITY_TYPES,
  EVENT_TYPES,
  HAZARD_TYPES,
  PERSISTENT_CAMERA_TYPES,
  SPEED_LIMIT_UNITS,
} from "../../config/constants.js";

export const speedLimitUnitEnum = pgEnum("speed_limit_unit", SPEED_LIMIT_UNITS);

export const correctionStatusEnum = pgEnum("correction_status", CORRECTION_STATUSES);

export const correctionVoteKindEnum = pgEnum("correction_vote_kind", CORRECTION_VOTE_KINDS);

export const correctionReasonEnum = pgEnum("correction_reason", CORRECTION_REASONS);

export const hazardTypeEnum = pgEnum("hazard_type", HAZARD_TYPES);

export const hazardStatusEnum = pgEnum("hazard_status", ["active", "expired", "removed"]);

export const hazardSourceEnum = pgEnum("hazard_source", ["community", "seed"]);

export const confirmationKindEnum = pgEnum("confirmation_kind", ["stillThere", "gone"]);

export const cameraStatusEnum = pgEnum("camera_status", ["active", "removed"]);

export const cameraTypeEnum = pgEnum("camera_type", PERSISTENT_CAMERA_TYPES);

export const eventTypeEnum = pgEnum("event_type", EVENT_TYPES);

export const entityTypeEnum = pgEnum("entity_type", ENTITY_TYPES);

/**
 * The spec's event_log field list includes moderationStatus, but every event that
 * reaches the log has already passed the synchronous moderation gate (rejected
 * writes never produce an event) — so "accepted" is the only value this takes in
 * Phase 1. Kept as an enum (not dropped) so a future async/appeal moderation flow
 * can introduce further states without a column type change.
 */
export const moderationStatusEnum = pgEnum("moderation_status", ["accepted"]);

export const clientScopeEnum = pgEnum("client_scope", CLIENT_SCOPES);

/** How this server first learned about a federation peer — network_peers.discovered_via (F-S3). */
export const peerDiscoverySourceEnum = pgEnum("peer_discovery_source", ["seed", "gossip", "join"]);
