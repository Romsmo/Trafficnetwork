import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, brotliDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { loadAssets, pickEncoding } from "../../src/modules/web/static.js";

const require = createRequire(import.meta.url);
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const table = loadAssets({
  publicDir: join(serverRoot, "web", "public"),
  leafletDir: join(dirname(require.resolve("leaflet/package.json")), "dist"),
  h3File: join(dirname(require.resolve("h3-js/package.json")), "dist", "browser", "h3-js.es.js"),
});

describe("web UI asset table", () => {
  it("has the three pages under their routes", () => {
    expect([...table.pages.keys()].sort()).toEqual(["/", "/about", "/connect"]);
    for (const asset of table.pages.values()) {
      expect(asset.contentType).toBe("text/html; charset=utf-8");
      expect(asset.cacheControl).toBe("no-cache");
    }
  });

  it("serves the app's own files and the vendored map libraries — and nothing else", () => {
    const routes = [...table.files.keys()];
    expect(routes).toContain("/web/js/map-page.js");
    expect(routes).toContain("/web/css/app.css");
    expect(routes).toContain("/web/i18n/de.js");
    expect(routes).toContain("/web/vendor/leaflet/leaflet.js");
    expect(routes).toContain("/web/vendor/leaflet/images/marker-icon.png");
    expect(routes).toContain("/web/vendor/h3/h3-js.es.js");
    for (const route of routes) {
      expect(route).toMatch(/^\/web\/[A-Za-z0-9_./-]+$/);
      expect(route).not.toContain("..");
    }
  });

  it("contains no third-party URLs in the pages or scripts (no CDN, fonts or trackers)", () => {
    const allowedHosts = new Set(["www.w3.org"]); // SVG namespace
    for (const [route, asset] of [...table.pages, ...table.files]) {
      if (route.startsWith("/web/vendor/")) continue;
      if (!/\.(html|js|css)$|^\/(about|connect)?$/.test(route)) continue;
      const text = asset.identity.toString("utf8");
      for (const match of text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
        const host = match[1]!.toLowerCase();
        // documentation/API hosts appear only as text in examples; the repo URL is injected at runtime, never hard-coded
        if (allowedHosts.has(host) || host === "localhost") continue;
        throw new Error(`${route} references external host ${host}`);
      }
    }
  });

  it("gives every asset a content hash ETag and pre-compresses the big text files", () => {
    const leaflet = table.files.get("/web/vendor/leaflet/leaflet.js")!;
    expect(leaflet.etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(leaflet.gzip!.length).toBeLessThan(leaflet.identity.length / 2);
    expect(gunzipSync(leaflet.gzip!).equals(leaflet.identity)).toBe(true);
    expect(brotliDecompressSync(leaflet.br!).equals(leaflet.identity)).toBe(true);
    expect(table.files.get("/web/vendor/leaflet/images/marker-icon.png")!.gzip).toBeUndefined();
  });

  it("picks the best encoding the client accepts", () => {
    const asset = table.files.get("/web/vendor/leaflet/leaflet.js")!;
    expect(pickEncoding(asset, "gzip, deflate, br").encoding).toBe("br");
    expect(pickEncoding(asset, "gzip").encoding).toBe("gzip");
    expect(pickEncoding(asset, undefined).encoding).toBeUndefined();
    expect(pickEncoding(asset, "identity").body).toBe(asset.identity);
  });
});
