const HOST_PATTERN = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:]+\])(?::\d{1,5})?$/i;

/**
 * Content-Security-Policy for the web UI's pages and files. Everything comes from this node itself except the
 * map tile images (one origin, from MAP_TILE_URL). WebSocket URLs are spelled out with the request's own Host
 * because older browsers do not treat 'self' as covering ws:/wss:. This policy is also what makes "the page makes
 * no other external request" enforceable rather than a promise.
 */
export function buildCsp(opts: { tileOrigin: string | null; host: string | undefined }): string {
  const connect = ["'self'"];
  if (opts.host && HOST_PATTERN.test(opts.host)) connect.push(`ws://${opts.host}`, `wss://${opts.host}`);
  const img = ["'self'", "data:"];
  if (opts.tileOrigin) img.push(opts.tileOrigin);
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src ${img.join(" ")}`,
    `connect-src ${connect.join(" ")}`,
    "font-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Headers for every web UI response (pages, files, config). */
export function securityHeaders(csp: string): Record<string, string> {
  return {
    "content-security-policy": csp,
    "x-content-type-options": "nosniff",
    // Origin only: the OSM tile policy requires a Referer, and this reveals no path or position.
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-frame-options": "DENY",
    // Position only after the visitor presses a button, and only for this origin.
    "permissions-policy": "geolocation=(self), camera=(), microphone=(), payment=()",
    "cross-origin-opener-policy": "same-origin",
  };
}
