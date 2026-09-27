import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, brotliDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadAssets, pickEncoding, versionModuleImports } from "../../src/modules/web/static.js";

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

  it("fingerprints the release and ties every link between pages and scripts to it, so versioned URLs can be cached for good", () => {
    expect(table.buildId).toMatch(/^[0-9a-f]{12}$/);
    const versioned = new RegExp(`\\.js\\?v=${table.buildId}$`);
    for (const [route, asset] of table.files) {
      if (!/^\/web\/(js|i18n)\//.test(route)) continue;
      const text = asset.identity.toString("utf8");
      for (const match of text.matchAll(/(?:from\s*|import\s*\(?\s*)["']((?:\.{1,2}\/|\/web\/)[^"']+\.js[^"']*)["']/g)) {
        expect(match[1], `${route} imports ${match[1]}`).toMatch(versioned);
      }
    }
    for (const [route, asset] of table.pages) {
      for (const match of asset.identity.toString("utf8").matchAll(/(?:href|src)="(\/web\/[^"]+)"/g)) {
        expect(match[1], `${route} links ${match[1]}`).toContain(`?v=${table.buildId}`);
      }
    }
  });

  it("changes the fingerprint whenever a served file changes", () => {
    const copy = mkdtempSync(join(tmpdir(), "tn-web-"));
    try {
      cpSync(join(serverRoot, "web", "public"), copy, { recursive: true });
      const sources = {
        publicDir: copy,
        leafletDir: join(dirname(require.resolve("leaflet/package.json")), "dist"),
        h3File: join(dirname(require.resolve("h3-js/package.json")), "dist", "browser", "h3-js.es.js"),
      };
      const before = loadAssets(sources).buildId;
      expect(loadAssets(sources).buildId).toBe(before);
      const file = join(copy, "assets", "css", "app.css");
      writeFileSync(file, `${readFileSync(file, "utf8")}\n/* changed */\n`);
      expect(loadAssets(sources).buildId).not.toBe(before);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  it("makes the browser fetch a page's whole module graph and the config in parallel — but not modules that load on demand", () => {
    const index = table.pages.get("/")!.identity.toString("utf8");
    for (const route of ["/web/js/map-page.js", "/web/js/api.js", "/web/js/i18n.js", "/web/i18n/de.js", "/web/i18n/en.js", "/web/js/limits-layer.js"]) {
      expect(index).toContain(`<link rel="modulepreload" href="${route}?v=${table.buildId}">`);
    }
    expect(index).not.toMatch(/modulepreload" href="\/web\/vendor\/h3/);
    expect(index).toContain('<link rel="preload" href="/web-config.json" as="fetch" crossorigin>');
    const about = table.pages.get("/about")!.identity.toString("utf8");
    expect(about).toContain(`modulepreload" href="/web/js/about-page.js?v=${table.buildId}"`);
    expect(about).not.toContain("map-page.js");
  });

  it("opens the connection to the tile server early, on the map page only, and only when tiles are configured", () => {
    const sources = {
      publicDir: join(serverRoot, "web", "public"),
      leafletDir: join(dirname(require.resolve("leaflet/package.json")), "dist"),
      h3File: join(dirname(require.resolve("h3-js/package.json")), "dist", "browser", "h3-js.es.js"),
    };
    const hint = '<link rel="preconnect" href="https://tiles.example">';
    const withTiles = loadAssets({ ...sources, tileOrigin: "https://tiles.example" });
    expect(withTiles.pages.get("/")!.identity.toString("utf8")).toContain(hint);
    expect(withTiles.pages.get("/about")!.identity.toString("utf8")).not.toContain("preconnect");
    expect(withTiles.pages.get("/connect")!.identity.toString("utf8")).not.toContain("preconnect");
    expect(table.pages.get("/")!.identity.toString("utf8")).not.toContain("preconnect");
  });

  it("refuses to start when a module imports a file that is not served, and leaves on-demand imports out of the startup graph", () => {
    const known = new Set(["/web/js/a.js", "/web/js/b.js", "/web/vendor/h3/h3-js.es.js"]);
    expect(() => versionModuleImports("/web/js/a.js", 'import { x } from "./missing.js";', known, "abc")).toThrow(/missing\.js/);
    const { text, imports } = versionModuleImports("/web/js/a.js", 'import { y } from "./b.js";\nconst m = await import("/web/vendor/h3/h3-js.es.js");', known, "abc");
    expect(imports).toEqual(["/web/js/b.js"]);
    expect(text).toContain('from "./b.js?v=abc"');
    expect(text).toContain('import("/web/vendor/h3/h3-js.es.js?v=abc")');
  });
});
