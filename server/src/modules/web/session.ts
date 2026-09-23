import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { signToken } from "../auth/jwt.js";
import { forbidden } from "../../lib/errors.js";
import { WEB_SESSION_SUBJECT_PREFIX } from "./guard.js";

/**
 * POST /v1/web/session — the one additive API endpoint of the web UI. Registered only when WEB_UI_ENABLED.
 *
 * Every /v1 read needs a Bearer token and a web page cannot hold a secret, so the page asks the node for an
 * anonymous, short-lived session instead: a normal JWT whose subject is `web:<random>`. No database row, no
 * client secret, nothing linking two sessions of the same browser (each renewal is a fresh identity, which is
 * also why the real limits are per IP, not per session — see guard.ts). What such a token may do is decided
 * by the default-deny allowlist in guard.ts, not by its scopes.
 */
export async function registerWebSessionRoute(app: FastifyInstance): Promise<void> {
  const env = app.deps.env;

  app.post(
    "/v1/web/session",
    { config: { rateLimit: { max: env.WEB_SESSION_MINT_LIMIT_PER_MINUTE, timeWindow: "1 minute" } } },
    async (req) => {
      // Browsers label every request with Sec-Fetch-Site and page scripts cannot forge it. Refusing anything
      // but our own page (or a direct navigation) stops a malicious site from making its visitors' browsers
      // mint sessions and spend their IP's quota — the API's CORS policy is open to every origin. Clients that
      // send no such header (curl, scripts) are unaffected; they are held to the same guard and limits.
      const site = req.headers["sec-fetch-site"];
      if (typeof site === "string" && site !== "same-origin" && site !== "none") {
        throw forbidden("Web sessions can only be created from this node's own web page");
      }

      const sub = `${WEB_SESSION_SUBJECT_PREFIX}${randomBytes(16).toString("base64url")}`;
      const accessToken = await signToken({ sub, scopes: ["client"] }, { JWT_SECRET: env.JWT_SECRET, JWT_TTL_SECONDS: env.WEB_SESSION_TTL_SECONDS });
      return { accessToken, tokenType: "Bearer", expiresIn: env.WEB_SESSION_TTL_SECONDS, scopes: ["client"] };
    },
  );
}
