import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, posix } from "node:path";
import { brotliCompressSync, gzipSync, constants as zlibConstants } from "node:zlib";

/**
 * The web UI's files are read into memory once at startup and served from a fixed table. No request path is
 * ever turned into a filesystem path, so there is nothing to traverse, and nothing outside this table can be
 * served by accident. (A small dedicated handler instead of @fastify/static: that package's current major
 * tracks a newer Fastify than this server uses, and this needs about 80 lines.)
 */

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".svg", ".txt"]);

export interface Asset {
  contentType: string;
  etag: string;
  cacheControl: string;
  identity: Buffer;
  gzip?: Buffer;
  br?: Buffer;
}

export interface AssetTable {
  /** Full pages, keyed by route: "/", "/connect", "/about". */
  pages: Map<string, Asset>;
  /** Static files, keyed by route under "/web/...". */
  files: Map<string, Asset>;
  /**
   * Fingerprint of every served file. All references between the pages and scripts carry it as `?v=<buildId>`, so a
   * request with the current id may be cached for good (a new release changes every URL), while everything else is revalidated.
   */
  buildId: string;
}

/** Cache header for a request that carries the current build id. */
export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

function makeAsset(body: Buffer, extension: string, cacheControl: string): Asset {
  const contentType = CONTENT_TYPES[extension];
  if (!contentType) throw new Error(`web UI: no content type known for "${extension}" files`);
  const asset: Asset = {
    contentType,
    etag: `"${createHash("sha1").update(body).digest("base64url")}"`,
    cacheControl,
    identity: body,
  };
  if (COMPRESSIBLE.has(extension) && body.length > 1024) {
    asset.gzip = gzipSync(body, { level: 9 });
    asset.br = brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 } });
  }
  return asset;
}

function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = prefix === "" ? name : `${prefix}/${name}`;
    if (statSync(full).isDirectory()) out.push(...listFiles(full, rel));
    else out.push(rel);
  }
  return out.sort();
}

/** Pages are always revalidated (ETag => 304); vendored libraries are cached for a day. */
const PAGE_CACHE = "no-cache";
const APP_CACHE = "no-cache";
const VENDOR_CACHE = "public, max-age=86400";

export interface AssetSources {
  /** server/web/public — contains pages/ and assets/. */
  publicDir: string;
  /** node_modules/leaflet/dist */
  leafletDir: string;
  /** node_modules/h3-js/dist/browser/h3-js.es.js */
  h3File: string;
  /** Origin of the map tile server (from MAP_TILE_URL), or null/undefined when the page shows no map background. */
  tileOrigin?: string | null;
}

/** A module specifier that points into the web UI's own tree: "./x.js", "../i18n/de.js" or "/web/vendor/h3/h3-js.es.js". */
const MODULE_SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])((?:\.{1,2}\/|\/web\/)[^"'?]+\.js)\2/g;
const ASSET_ATTRIBUTE = /(\b(?:href|src)=")(\/web\/[^"?#]+)(")/g;
const MODULE_ENTRY = /<script\s+type="module"\s+src="(\/web\/[^"?]+)"/;

/** Only the app's own modules are rewritten; vendored files are served exactly as shipped. */
const isAppModule = (route: string) => route.startsWith("/web/js/") || route.startsWith("/web/i18n/");

function resolveSpecifier(fromRoute: string, specifier: string): string {
  return specifier.startsWith("/") ? specifier : posix.normalize(posix.join(posix.dirname(fromRoute), specifier));
}

/**
 * Appends `?v=<buildId>` to every import of an app module and returns the modules it imports. An import that does not
 * resolve to a served file fails here, at startup, instead of as a 404 in a visitor's browser.
 */
export function versionModuleImports(route: string, source: string, known: ReadonlySet<string>, buildId: string): { text: string; imports: string[] } {
  const imports: string[] = [];
  const text = source.replace(MODULE_SPECIFIER, (_match, lead: string, quote: string, specifier: string) => {
    const target = resolveSpecifier(route, specifier);
    if (!known.has(target)) throw new Error(`web UI: ${route} imports ${specifier}, which is not a served file`);
    // Only static imports are needed to start the page; a dynamic import() is fetched when the code asks for it.
    if (!lead.includes("(")) imports.push(target);
    return `${lead}${quote}${specifier}?v=${buildId}${quote}`;
  });
  return { text, imports };
}

/** Versions the page's own asset links and adds hints so the browser fetches the whole module graph and the config in parallel. */
export function preparePage(html: string, known: ReadonlySet<string>, graph: ReadonlyMap<string, string[]>, buildId: string, tileOrigin: string | null = null): string {
  const versioned = html.replace(ASSET_ATTRIBUTE, (_match, lead: string, route: string, tail: string) => {
    if (!known.has(route)) throw new Error(`web UI: a page references ${route}, which is not a served file`);
    return `${lead}${route}?v=${buildId}${tail}`;
  });

  const entry = MODULE_ENTRY.exec(html)?.[1];
  const modules: string[] = [];
  if (entry) {
    const queue = [entry];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (modules.includes(next)) continue;
      modules.push(next);
      queue.push(...(graph.get(next) ?? []));
    }
  }
  const hints = [
    // The map's first tiles are the slowest thing on a cold visit (DNS + TCP + TLS to another server): open that connection early.
    ...(tileOrigin && html.includes('id="map"') ? [`<link rel="preconnect" href="${tileOrigin}">`] : []),
    ...modules.map((route) => `<link rel="modulepreload" href="${route}?v=${buildId}">`),
    // every page starts by reading it; asking for it while the HTML is still being parsed saves a round trip
    `<link rel="preload" href="/web-config.json" as="fetch" crossorigin>`,
  ].join("\n");
  return versioned.replace("</head>", `${hints}\n</head>`);
}

export function loadAssets(sources: AssetSources): AssetTable {
  const PAGE_ROUTES: Record<string, string> = { "index.html": "/", "connect.html": "/connect", "about.html": "/about" };
  const pageSources = new Map<string, { body: Buffer; ext: string }>();
  const pagesDir = join(sources.publicDir, "pages");
  for (const rel of listFiles(pagesDir)) {
    const route = PAGE_ROUTES[rel];
    if (!route) throw new Error(`web UI: pages/${rel} has no route (known pages: ${Object.keys(PAGE_ROUTES).join(", ")})`);
    pageSources.set(route, { body: readFileSync(join(pagesDir, rel)), ext: extname(rel) });
  }
  for (const [file, route] of Object.entries(PAGE_ROUTES)) {
    if (!pageSources.has(route)) throw new Error(`web UI: missing page pages/${file}`);
  }

  const fileSources = new Map<string, { body: Buffer; ext: string; cache: string }>();
  const assetsDir = join(sources.publicDir, "assets");
  for (const rel of listFiles(assetsDir)) {
    fileSources.set(`/web/${rel}`, { body: readFileSync(join(assetsDir, rel)), ext: extname(rel), cache: APP_CACHE });
  }
  for (const rel of ["leaflet.js", "leaflet.css", "images/layers.png", "images/layers-2x.png", "images/marker-icon.png", "images/marker-icon-2x.png", "images/marker-shadow.png"]) {
    fileSources.set(`/web/vendor/leaflet/${rel}`, { body: readFileSync(join(sources.leafletDir, rel)), ext: extname(rel), cache: VENDOR_CACHE });
  }
  fileSources.set(`/web/vendor/h3/${basename(sources.h3File)}`, { body: readFileSync(sources.h3File), ext: ".js", cache: VENDOR_CACHE });

  // The fingerprint covers the files as they are on disk, before any rewriting.
  const fingerprint = createHash("sha1");
  const everything = [...pageSources, ...fileSources].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [route, source] of everything) {
    fingerprint.update(`${route}\0${createHash("sha1").update(source.body).digest("hex")}\0`);
  }
  const buildId = fingerprint.digest("hex").slice(0, 12);

  const known = new Set(fileSources.keys());
  const graph = new Map<string, string[]>();
  const files = new Map<string, Asset>();
  for (const [route, source] of fileSources) {
    let body = source.body;
    if (source.ext === ".js" && isAppModule(route)) {
      const { text, imports } = versionModuleImports(route, body.toString("utf8"), known, buildId);
      graph.set(route, imports);
      body = Buffer.from(text, "utf8");
    }
    files.set(route, makeAsset(body, source.ext, source.cache));
  }

  const pages = new Map<string, Asset>();
  for (const [route, source] of pageSources) {
    const html = preparePage(source.body.toString("utf8"), known, graph, buildId, sources.tileOrigin ?? null);
    pages.set(route, makeAsset(Buffer.from(html, "utf8"), source.ext, PAGE_CACHE));
  }

  return { pages, files, buildId };
}

/** Picks the best pre-compressed variant the client accepts. */
export function pickEncoding(asset: Asset, acceptEncoding: string | undefined): { body: Buffer; encoding?: "br" | "gzip" } {
  const accepted = (acceptEncoding ?? "").toLowerCase();
  if (asset.br && /\bbr\b/.test(accepted)) return { body: asset.br, encoding: "br" };
  if (asset.gzip && /\bgzip\b/.test(accepted)) return { body: asset.gzip, encoding: "gzip" };
  return { body: asset.identity };
}
