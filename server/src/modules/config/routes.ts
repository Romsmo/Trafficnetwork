import type { FastifyInstance } from "fastify";
import { getStaticDataVersion } from "../../db/queries/sync-state.js";
import { CAMERA_NAMESPACE_TYPES, hazardExpiryMs, REPORTABLE_HAZARD_TYPES } from "../../config/constants.js";

/**
 * Curated subset of server env tunables a client-lib instance must mirror
 * locally (local expiry calc, tiling, camera-namespace isolation) so it can
 * never drift from the server's own rules (docs/prompt-phase2-client-lib.md
 * section 3.3). Ordinary auth like any other read — no dedicated scope.
 */
export async function registerConfigRoutes(app: FastifyInstance) {
  app.get("/v1/config", async () => {
    const env = app.deps.env;
    const expiryByType = Object.fromEntries(
      REPORTABLE_HAZARD_TYPES.map((type) => [type, hazardExpiryMs(type, env)]),
    );

    return {
      regionTileH3Resolution: env.REGION_TILE_H3_RESOLUTION,
      staticDataPartitionH3Resolution: env.STATIC_DATA_PARTITION_H3_RESOLUTION,
      speedCameraNamespaceEnabled: env.SPEED_CAMERA_NAMESPACE_ENABLED,
      cameraNamespaceHazardTypes: CAMERA_NAMESPACE_TYPES,
      duplicateMergeRadiusMeters: env.DUPLICATE_MERGE_RADIUS_METERS,
      speedLimitLookupMaxDistanceMeters: env.SPEED_LIMIT_LOOKUP_MAX_DISTANCE_METERS,
      hazardExpiryMsByType: expiryByType,
      reportRateLimitMax: env.REPORT_RATE_LIMIT_MAX,
      reportRateLimitWindowMinutes: env.REPORT_RATE_LIMIT_WINDOW_MINUTES,
      cameraRemovalThreshold: env.CAMERA_REMOVAL_THRESHOLD,
      // Community speed-limit corrections (add-on K-A). Clients hide the whole
      // feature when `enabled` is false and mirror the limits below to reject
      // implausible input before it is sent.
      communityCorrections: {
        enabled: env.COMMUNITY_CORRECTIONS_ENABLED,
        confirmationsRequired: env.COMMUNITY_CORRECTIONS_CONFIRMATIONS_REQUIRED,
        valueRange: {
          kmh: { min: env.COMMUNITY_CORRECTIONS_KMH_MIN, max: env.COMMUNITY_CORRECTIONS_KMH_MAX },
          mph: { min: env.COMMUNITY_CORRECTIONS_MPH_MIN, max: env.COMMUNITY_CORRECTIONS_MPH_MAX },
        },
        valueStep: env.COMMUNITY_CORRECTIONS_VALUE_STEP,
        rateLimit: {
          max: env.COMMUNITY_CORRECTIONS_RATE_LIMIT_MAX,
          windowMinutes: env.COMMUNITY_CORRECTIONS_RATE_LIMIT_WINDOW_MINUTES,
        },
      },
      staticDataVersion: await getStaticDataVersion(app.deps.db),
      federationEnabled: env.FEDERATION_ENABLED,
      // Full signed envelope (payload + keyId + signature), not just the
      // values — so a client can independently re-verify it against the
      // network root public key it already trusts, rather than taking this
      // server's word for speedCameraNamespaceEnabled etc. above. null for a
      // server with no NETWORK_CONFIG_PATH configured (today's default).
      networkConfig: app.networkConfig,
    };
  });
}
