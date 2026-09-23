import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
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
}

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
}

export function loadAssets(sources: AssetSources): AssetTable {
  const pages = new Map<string, Asset>();
  const files = new Map<string, Asset>();

  const PAGE_ROUTES: Record<string, string> = { "index.html": "/", "connect.html": "/connect", "about.html": "/about" };
  const pagesDir = join(sources.publicDir, "pages");
  for (const rel of listFiles(pagesDir)) {
    const route = PAGE_ROUTES[rel];
    if (!route) throw new Error(`web UI: pages/${rel} has no route (known pages: ${Object.keys(PAGE_ROUTES).join(", ")})`);
    pages.set(route, makeAsset(readFileSync(join(pagesDir, rel)), extname(rel), PAGE_CACHE));
  }
  for (const [file, route] of Object.entries(PAGE_ROUTES)) {
    if (!pages.has(route)) throw new Error(`web UI: missing page pages/${file}`);
  }

  const assetsDir = join(sources.publicDir, "assets");
  for (const rel of listFiles(assetsDir)) {
    files.set(`/web/${rel}`, makeAsset(readFileSync(join(assetsDir, rel)), extname(rel), APP_CACHE));
  }

  for (const rel of ["leaflet.js", "leaflet.css", "images/layers.png", "images/layers-2x.png", "images/marker-icon.png", "images/marker-icon-2x.png", "images/marker-shadow.png"]) {
    files.set(`/web/vendor/leaflet/${rel}`, makeAsset(readFileSync(join(sources.leafletDir, rel)), extname(rel), VENDOR_CACHE));
  }
  files.set(`/web/vendor/h3/${basename(sources.h3File)}`, makeAsset(readFileSync(sources.h3File), ".js", VENDOR_CACHE));

  return { pages, files };
}

/** Picks the best pre-compressed variant the client accepts. */
export function pickEncoding(asset: Asset, acceptEncoding: string | undefined): { body: Buffer; encoding?: "br" | "gzip" } {
  const accepted = (acceptEncoding ?? "").toLowerCase();
  if (asset.br && /\bbr\b/.test(accepted)) return { body: asset.br, encoding: "br" };
  if (asset.gzip && /\bgzip\b/.test(accepted)) return { body: asset.gzip, encoding: "gzip" };
  return { body: asset.identity };
}
