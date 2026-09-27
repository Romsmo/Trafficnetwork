/**
 * Map tile URL handling for the web UI (MAP_TILE_URL). Only the classic {z}/{x}/{y} template is
 * supported — no {s} subdomain rotation, no {r} retina suffix — which keeps the Content-Security-Policy
 * to exactly one extra origin.
 */

/** OpenStreetMap's public tile server — the default when MAP_TILE_URL is unset or empty. */
export const DEFAULT_MAP_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

function toProbeUrl(template: string): string {
  return template.replace("{z}", "1").replace("{x}", "0").replace("{y}", "0");
}

/** "" (tiles disabled) or an http(s) URL with {z}, {x}, {y} exactly once each, without credentials or {s}. */
export function isAcceptableTileUrl(template: string): boolean {
  if (template === "") return true;
  for (const placeholder of ["{z}", "{x}", "{y}"]) {
    if (template.split(placeholder).length !== 2) return false;
  }
  if (template.includes("{s}")) return false;
  try {
    const url = new URL(toProbeUrl(template));
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.username !== "" || url.password !== "") return false;
    return url.hostname !== "";
  } catch {
    return false;
  }
}

/** Origin (scheme + host[:port]) the browser has to be allowed to load images from, or null if tiles are off. */
export function tileOrigin(template: string): string | null {
  if (template === "" || !isAcceptableTileUrl(template)) return null;
  return new URL(toProbeUrl(template)).origin;
}
