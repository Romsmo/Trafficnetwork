/** Runtime configuration of this node's web UI (version, repo link, tile source, limits) — one small JSON file. */
export async function loadWebConfig(fetchImpl = globalThis.fetch.bind(globalThis)) {
  const response = await fetchImpl("/web-config.json", { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`web-config.json: HTTP ${response.status}`);
  return response.json();
}

/** Host of the map tile server (for the privacy text), or null when no tiles are used. */
export function tileHost(config) {
  if (!config?.tiles?.url) return null;
  try {
    return new URL(config.tiles.url.replace("{z}", "1").replace("{x}", "0").replace("{y}", "0")).host;
  } catch {
    return null;
  }
}
