import type { FastifyInstance } from "fastify";
import { buildCsp, securityHeaders } from "../web/csp.js";
import { tileOrigin } from "../web/tile.js";
import { qrSvg } from "./qr.js";
import { ensurePublicJoinCode, refreshMetadata, showCode, type JoinContext, type JoinLog } from "./service.js";

const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

function logAdapter(app: FastifyInstance): JoinLog {
  return {
    info: (message) => app.log.info(message),
    warn: (message) => app.log.warn(message),
    error: (message) => app.log.error(message),
  };
}

/** Only the message of an error, never the error object: a failure here must not drag request data or file contents into the log. */
const messageOf = (err: unknown) => (err instanceof Error ? err.message : "unknown error");

export function joinContext(app: FastifyInstance): JoinContext {
  return { db: app.deps.db, env: app.deps.env, log: logAdapter(app) };
}

/**
 * Join codes (docs/join-code.md): the check/creation of the public code at start, the hourly refresh of the metadata files, and
 * - when the web UI is on and JOIN_CODE_PUBLIC is true - GET /join-code.json, which the page "App verbinden" reads.
 * A failure at start is logged and does not stop the node: the API works without a join code.
 */
export async function registerJoinModule(app: FastifyInstance): Promise<void> {
  const ctx = joinContext(app);
  const env = app.deps.env;

  try {
    const check = await ensurePublicJoinCode(ctx);
    if (check.state === "ok") app.log.info("join code: public code checked, it matches its app key");
    if (check.state === "ok" || check.state === "created") await refreshMetadata(ctx);
  } catch (err) {
    app.log.error(`join code: the check at start failed (${messageOf(err)}); the node runs without it`);
  }

  const timer = setInterval(() => {
    refreshMetadata(ctx).catch((err: unknown) => app.log.warn(`join code: refreshing the metadata failed (${messageOf(err)})`));
  }, REFRESH_INTERVAL_MS);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));

  if (!env.WEB_UI_ENABLED || !env.JOIN_CODE_PUBLIC) return;
  const origin = tileOrigin(env.MAP_TILE_URL);

  // The page reads this. Like the page itself it is public by design (docs/join-code.md "Security model"); an invitation code is
  // never answered here - only the current public code. Not cached anywhere.
  app.get("/join-code.json", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    reply.headers(securityHeaders(buildCsp({ tileOrigin: origin, host: req.headers.host })));
    reply.header("cache-control", "no-store");
    let shown;
    try {
      shown = await showCode(ctx, null, { verifySecret: false });
    } catch (err) {
      app.log.warn(`join code: the page could not read the public code (${messageOf(err)})`);
      return { available: false };
    }
    if ("problem" in shown || shown.status === "revoked") return { available: false };
    return {
      available: true,
      node: shown.node,
      code: shown.uri,
      svg: qrSvg(shown.uri, "QR code for connecting an app to this node"),
      fingerprint: shown.rootFingerprint,
      status: shown.status,
    };
  });
}
