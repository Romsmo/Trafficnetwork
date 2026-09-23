/**
 * Request log line without personal data: method, path and host only. The default serializer also logs the
 * client's address and — far worse for a traffic service — the whole query string, i.e. the exact coordinates
 * of every lookup. Enabled by default (LOG_PRIVACY_MODE); an operator debugging a specific problem can turn it off.
 */
export function privacyRequestSerializer(req: { method?: string; url?: string; headers?: Record<string, unknown> }): {
  method?: string;
  url: string;
  host?: string;
} {
  const [path] = (req.url ?? "").split("?");
  const host = req.headers?.["host"];
  return { method: req.method, url: path ?? "", host: typeof host === "string" ? host : undefined };
}
