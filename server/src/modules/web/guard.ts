import type { FastifyInstance } from "fastify";
import type { Env } from "../../config/env.js";
import { CAMERA_NAMESPACE_TYPES, NON_CAMERA_HAZARD_TYPES } from "../../config/constants.js";
import { ApiError } from "../../lib/errors.js";
import { SlidingWindowLimiter, type LimitCheck } from "./limits.js";
import { stripReporterIds } from "./redact.js";

/** JWT subject prefix of anonymous web sessions (see session.ts). Real client ids are `client_<hex>`. */
export const WEB_SESSION_SUBJECT_PREFIX = "web:";

export function isWebSessionSubject(sub: string | undefined): sub is string {
  return typeof sub === "string" && sub.startsWith(WEB_SESSION_SUBJECT_PREFIX);
}

export type RequestCategory = "read" | "heavy-read" | "write";

export type GuardDecision =
  | { kind: "allow"; category: RequestCategory }
  | { kind: "deny"; status: number; code: string; message: string };

export interface WebPolicy {
  maxSegmentRadiusM: number;
  maxHazardRadiusM: number;
  /** Effective camera-namespace flag (env already AND-gated with the signed network config). */
  cameraNamespaceEnabled: boolean;
}

export interface WebRequestInfo {
  method: string;
  path: string;
  query: Record<string, unknown>;
  body: unknown;
}

const deny = (status: number, code: string, message: string): GuardDecision => ({ kind: "deny", status, code, message });

const CONFIRMATION_PATH = /^\/v1\/hazard-reports\/[^/]+\/confirmations$/;

function radiusExceeds(query: Record<string, unknown>, max: number): boolean {
  const raw = query["radiusM"];
  if (raw === undefined) return false; // the endpoint's own validation reports a missing radius
  const radius = Number(raw);
  return Number.isFinite(radius) && radius > max;
}

/**
 * Default-deny allowlist for what an anonymous web session may do on /v1. Anything not listed — including
 * every endpoint added in the future — is refused, so the public web UI can never widen the attack surface
 * of the API by accident (snapshot/delta/static-data are heavy, bind-key/register/bulk-import are privileged).
 */
export function classifyWebRequest(info: WebRequestInfo, policy: WebPolicy): GuardDecision {
  const { method, path, query, body } = info;

  if (method === "GET") {
    switch (path) {
      case "/v1/config":
      case "/v1/speed-limit":
      case "/v1/hazard-reports/by-tile":
      case "/v1/speed-cameras/nearby":
      case "/v1/speed-cameras/by-tile":
        return { kind: "allow", category: "read" };
      case "/v1/hazard-reports/nearby":
        if (radiusExceeds(query, policy.maxHazardRadiusM)) {
          return deny(400, "WEB_RADIUS_TOO_LARGE", `Web sessions may query at most ${policy.maxHazardRadiusM} m around a point`);
        }
        return { kind: "allow", category: "read" };
      case "/v1/speed-limit-segments/nearby":
        if (radiusExceeds(query, policy.maxSegmentRadiusM)) {
          return deny(400, "WEB_RADIUS_TOO_LARGE", `Web sessions may query road segments within at most ${policy.maxSegmentRadiusM} m of a point`);
        }
        return { kind: "allow", category: "heavy-read" };
      default:
        break;
    }
  }

  if (method === "POST" && path === "/v1/hazard-reports") {
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    // A device signature would make the report federation-eligible; browser sessions are anonymous and
    // free to mint, so their reports stay on this node (docs/web-ui.md, "Trust model").
    if (record["deviceAssertion"] !== undefined) {
      return deny(403, "WEB_NO_DEVICE_SIGNATURE", "Web sessions cannot submit device-signed reports; their reports stay on this node");
    }
    const type = record["type"];
    if (typeof type === "string") {
      const allowed = (NON_CAMERA_HAZARD_TYPES as readonly string[]).includes(type) ||
        (policy.cameraNamespaceEnabled && (CAMERA_NAMESPACE_TYPES as readonly string[]).includes(type));
      if (!allowed) return deny(403, "WEB_TYPE_NOT_ALLOWED", "This report type is not available to web sessions on this node");
    }
    return { kind: "allow", category: "write" };
  }

  if (method === "POST" && CONFIRMATION_PATH.test(path)) {
    return { kind: "allow", category: "write" };
  }

  return deny(403, "WEB_SESSION_FORBIDDEN", "This endpoint is not available to web sessions");
}

/** Limit checks for one allowed request, given its category and who is asking. */
export function limitChecksFor(category: RequestCategory, sub: string, ip: string, env: Env): LimitCheck[] {
  switch (category) {
    case "read":
      return [{ key: `read:${ip}`, max: env.WEB_READ_LIMIT_PER_IP_PER_MINUTE, windowMs: 60_000, scope: "network (reads)" }];
    case "heavy-read":
      return [
        { key: `read:${ip}`, max: env.WEB_READ_LIMIT_PER_IP_PER_MINUTE, windowMs: 60_000, scope: "network (reads)" },
        { key: `heavy:${ip}`, max: env.WEB_HEAVY_READ_LIMIT_PER_IP_PER_MINUTE, windowMs: 60_000, scope: "network (map layer)" },
      ];
    case "write":
      return [
        { key: `wsess:${sub}`, max: env.WEB_REPORT_LIMIT_PER_SESSION, windowMs: env.REPORT_RATE_LIMIT_WINDOW_MINUTES * 60_000, scope: "session" },
        { key: `wip:${ip}`, max: env.WEB_REPORT_LIMIT_PER_IP_PER_HOUR, windowMs: 3_600_000, scope: "network" },
        { key: "wnode", max: env.WEB_REPORT_LIMIT_NODE_PER_HOUR, windowMs: 3_600_000, scope: "node" },
      ];
  }
}

/**
 * Registered right after the auth hook and before any route (see app.ts): from then on every request that
 * carries a web-session token is checked here, after the body has been parsed and before the route runs.
 * Requests with any other kind of token are not touched.
 */
export async function registerWebGuard(app: FastifyInstance): Promise<void> {
  const env = app.deps.env;
  if (!env.WEB_UI_ENABLED) return;

  const limiter = new SlidingWindowLimiter();
  const pruneTimer = setInterval(() => limiter.prune(3_600_000), 60_000);
  pruneTimer.unref();
  app.addHook("onClose", async () => clearInterval(pruneTimer));

  // Anonymous visitors do not get to see other devices' pseudonymous reporter ids (they need no credential at all).
  app.addHook("preSerialization", async (req, _reply, payload) => {
    return isWebSessionSubject(req.auth?.sub) ? stripReporterIds(payload) : payload;
  });

  app.addHook("preValidation", async (req, reply) => {
    const sub = req.auth?.sub;
    if (!isWebSessionSubject(sub)) return;

    const path = req.url.split("?")[0] ?? "";
    const decision = classifyWebRequest(
      { method: req.method, path, query: (req.query ?? {}) as Record<string, unknown>, body: req.body },
      { maxSegmentRadiusM: env.WEB_MAX_SEGMENT_RADIUS_M, maxHazardRadiusM: env.WEB_MAX_HAZARD_RADIUS_M, cameraNamespaceEnabled: env.SPEED_CAMERA_NAMESPACE_ENABLED },
    );
    if (decision.kind === "deny") throw new ApiError(decision.status, decision.code, decision.message);

    const result = limiter.tryConsume(limitChecksFor(decision.category, sub, req.ip, env));
    if (!result.allowed) {
      reply.header("retry-after", String(result.retryAfterSeconds));
      const minutes = Math.max(1, Math.ceil(result.retryAfterSeconds / 60));
      throw new ApiError(429, "WEB_RATE_LIMITED", `Too many requests from this ${result.scope} — try again in about ${minutes} min`, {
        scope: result.scope,
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }
  });
}
