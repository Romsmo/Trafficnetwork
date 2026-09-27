import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const TILE_ORIGIN = "https://tile.openstreetmap.org";

/** A 1x1 transparent PNG: stands in for map tiles so the suite runs offline and never hits the real tile server. */
const BLANK_TILE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

export interface Traffic {
  /** Requests that left the node's own origin and were not map tiles (must stay empty). */
  external: string[];
  tiles: string[];
  /** WebSocket URLs the page opened. */
  sockets: string[];
  /** Content-Security-Policy violations the browser reported. */
  cspViolations: () => Promise<string[]>;
  consoleErrors: string[];
}

/** Watches everything the page does on the network; tiles are answered locally, anything else external is blocked and recorded. */
export async function watchTraffic(page: Page, nodeUrl: string, { fakeTiles = true }: { fakeTiles?: boolean } = {}): Promise<Traffic> {
  const nodeOrigin = new URL(nodeUrl).origin;
  const traffic: Traffic = { external: [], tiles: [], sockets: [], consoleErrors: [], cspViolations: async () => [] };

  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = seen;
    document.addEventListener("securitypolicyviolation", (event) => seen.push(`${event.violatedDirective} ${event.blockedURI}`));
  });
  traffic.cspViolations = () => page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === nodeOrigin) return route.continue();
    if (url.origin === TILE_ORIGIN) {
      traffic.tiles.push(url.href);
      return fakeTiles ? route.fulfill({ status: 200, contentType: "image/png", body: BLANK_TILE }) : route.continue();
    }
    traffic.external.push(url.href);
    return route.abort();
  });
  page.on("websocket", (socket) => traffic.sockets.push(socket.url()));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // The "N online" display probes GET /v1/stats/online; a node without that add-on answers 401/404 and the browser logs it.
    // That is the display's designed way of finding out that there is no counter, not an error of the page.
    if (message.location().url.includes("/v1/stats/online")) return;
    traffic.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => traffic.consoleErrors.push(`pageerror: ${error.message}`));
  return traffic;
}

/** Counts every call the page makes to the browser's geolocation API (it must be zero until the visitor presses a button). */
export async function countGeolocationCalls(page: Page): Promise<() => Promise<number>> {
  await page.addInitScript(() => {
    const counter = { calls: 0 };
    (window as unknown as { __geo: typeof counter }).__geo = counter;
    for (const method of ["getCurrentPosition", "watchPosition"] as const) {
      const original = navigator.geolocation[method].bind(navigator.geolocation);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (navigator.geolocation as any)[method] = (...args: unknown[]) => {
        counter.calls += 1;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (original as any)(...args);
      };
    }
  });
  return () => page.evaluate(() => (window as unknown as { __geo: { calls: number } }).__geo.calls);
}

/** Opens the map page and waits until the map, the node's config and the live connection are ready. */
export async function openMap(page: Page, nodeUrl: string): Promise<void> {
  await page.goto(`${nodeUrl}/`);
  await expect(page.locator("#map.leaflet-container")).toBeVisible();
  await expect(page.locator("#live-chip.ok")).toBeVisible();
}

/** Creates a report through the same public API the page uses, as a separate anonymous web visitor. */
export async function reportViaApi(request: APIRequestContext, nodeUrl: string, body: { type: string; lat: number; lng: number }): Promise<{ id: string; merged: boolean }> {
  const session = await request.post(`${nodeUrl}/v1/web/session`, { headers: { "sec-fetch-site": "same-origin" } });
  expect(session.ok()).toBe(true);
  const { accessToken } = (await session.json()) as { accessToken: string };
  const response = await request.post(`${nodeUrl}/v1/hazard-reports`, { headers: { authorization: `Bearer ${accessToken}` }, data: body });
  expect(response.status(), await response.text()).toBeLessThan(300);
  const { report, merged } = (await response.json()) as { report: { id: string }; merged?: boolean };
  return { id: report.id, merged: merged === true };
}

/** Fills and submits the report dialog for a category (position: the dialog's default, i.e. the current map centre). */
export async function submitReportDialog(page: Page, typeLabel: string): Promise<void> {
  await page.locator("#report-open").click();
  const dialog = page.locator("#report-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: typeLabel, exact: true }).check();
  await dialog.getByRole("button", { name: "Melden", exact: true }).click();
}
