import type { FastifyInstance } from "fastify";
import { resolveReportExpiry, type ReportExpiryRules } from "../../config/report-expiry.js";

interface Cached {
  /** The signature of the signed network configuration the rules were resolved from ("" = none). */
  key: string;
  rules: ReportExpiryRules;
}

const cache = new WeakMap<FastifyInstance, Cached>();

/**
 * The report expiry rules in force on this node *now*: this node's environment with the signed network configuration
 * applied. The signed configuration is re-read while the node runs (modules/cameras/policy), so this follows it; the
 * result is recomputed only when the configuration's signature changes, and a difference between the node's own
 * setting and the signed one is logged once per change.
 */
export function currentReportExpiry(app: FastifyInstance): ReportExpiryRules {
  const envelope = app.networkConfig;
  const key = envelope?.signature ?? "";
  const cached = cache.get(app);
  if (cached && cached.key === key) return cached.rules;

  const rules = resolveReportExpiry(app.deps.env, envelope?.payload ?? null, (message) => app.log.warn(message));
  cache.set(app, { key, rules });
  return rules;
}
