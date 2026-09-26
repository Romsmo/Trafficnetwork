import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = path.resolve(fileURLToPath(import.meta.url), "../../fixtures/nvdb-no");
const read = (name: string): string => readFileSync(path.join(FIXTURES, name), "utf8");

export interface FakeNvdbRequest {
  url: URL;
  headers: IncomingHttpHeaders;
}

export interface FakeNvdb {
  baseUrl: string;
  requests: FakeNvdbRequest[];
  /** Municipality numbers whose sign requests answer 503 while this is set (a service outage in the middle of a run). */
  failMunicipalities: Set<number>;
  /** Value of `x-ratelimit-remaining` sent with every answer. */
  rateLimitRemaining: number;
  /** When false the fake ignores the `egenskap` series filter (a server that does not honour it): the client must then decide the series itself. Default true, as the real API. */
  applyFilter: boolean;
  /** Writes every position of the sign pages as lon/lat instead of the API's lat/lon (simulates a changed axis order). */
  mirrorPositions: boolean;
  close: () => Promise<void>;
}

/**
 * A stand-in for NVDB API Les V4 that serves REAL responses (tests/fixtures/nvdb-no, fetched from the live API on 2026-09-26):
 *  - the type definition of 96 "Skiltplate" (reduced to property 5530), the municipality list (3 entries),
 *  - Utsira (1151): the whole municipality — one page of 32 plates, then the API's real end-of-data answer (an empty page that
 *    repeats the same cursor),
 *  - Oslo (301): the first two real pages; after them this server answers the way the real API does at the end of the data
 *    (empty page, same cursor) — Oslo really has far more plates, so this cut is the fixture's, not the API's,
 *  - Stavanger (1103): answers with an empty page and no cursor.
 * Like the real API it refuses a request without X-Client (HTTP 400).
 */
/** What the real API does with `egenskap(5530)in[ids]`: only plates whose Skiltnummer enum id is in the list are returned. */
function applySeriesFilter(body: string, filter: string | null): string {
  const ids = /^egenskap\(5530\)in\[([\d,]+)\]$/.exec(filter ?? "")?.[1]?.split(",").map(Number);
  if (!ids) return body;
  const page = JSON.parse(body) as { objekter: { egenskaper: { id: number; enum_id?: number }[] }[]; metadata: { returnert: number } };
  page.objekter = page.objekter.filter((o) => ids.includes(o.egenskaper.find((p) => p.id === 5530)?.enum_id ?? -1));
  page.metadata.returnert = page.objekter.length;
  return JSON.stringify(page);
}

export async function startFakeNvdb(): Promise<FakeNvdb> {
  const requests: FakeNvdbRequest[] = [];
  const failMunicipalities = new Set<number>();
  const fake = { rateLimitRemaining: 199, mirrorPositions: false, applyFilter: true };

  const emptyEnd = (cursor: string): string => JSON.stringify({ objekter: [], metadata: { returnert: 0, sidestørrelse: 800, neste: { start: cursor } } });

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push({ url, headers: req.headers });
    const send = (status: number, body: string, type = "application/json"): void => {
      if (fake.mirrorPositions && url.pathname === "/vegobjekter/96") body = body.replace(/"wkt":"POINT( Z)? ?\(([-\d.]+) ([-\d.]+)/g, '"wkt":"POINT$1 ($3 $2');
      if (url.pathname === "/vegobjekter/96" && status === 200) body = fake.applyFilter ? applySeriesFilter(body, url.searchParams.get("egenskap")) : body;
      res.writeHead(status, { "content-type": type, "x-ratelimit-remaining": String(fake.rateLimitRemaining) }).end(body);
    };

    if (!req.headers["x-client"]) return send(400, "X-Client må være satt når du kaller API Les V4.", "text/plain");
    if (url.pathname === "/vegobjekttyper/96") return send(200, read("type96-skiltnummer-excerpt.json"));
    if (url.pathname === "/omrader/kommuner") return send(200, read("kommuner-excerpt.json"));

    if (url.pathname === "/vegobjekter/96/statistikk") {
      const kommune = Number(url.searchParams.get("kommune"));
      return send(200, JSON.stringify({ antall: kommune === 1151 ? 32 : kommune === 301 ? 60 : 0, lengde: 0.0 }));
    }

    if (url.pathname === "/vegobjekter/96") {
      const kommune = Number(url.searchParams.get("kommune"));
      const start = url.searchParams.get("start");
      if (failMunicipalities.has(kommune)) return send(503, "service unavailable", "text/plain");
      if (kommune === 1151) return send(200, start === null ? read("signs-1151-page1.json") : read("signs-1151-page2-end.json"));
      if (kommune === 301) {
        if (start === null) return send(200, read("signs-0301-page1.json"));
        if (start === "86558599:4") return send(200, read("signs-0301-page2.json"));
        return send(200, emptyEnd(start));
      }
      return send(200, JSON.stringify({ objekter: [], metadata: { returnert: 0, sidestørrelse: 800 } }));
    }
    return send(404, JSON.stringify({ status: 404, error: "Not Found", path: url.pathname }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake NVDB failed to bind");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    failMunicipalities,
    get rateLimitRemaining() {
      return fake.rateLimitRemaining;
    },
    set rateLimitRemaining(value: number) {
      fake.rateLimitRemaining = value;
    },
    get applyFilter() {
      return fake.applyFilter;
    },
    set applyFilter(value: boolean) {
      fake.applyFilter = value;
    },
    get mirrorPositions() {
      return fake.mirrorPositions;
    },
    set mirrorPositions(value: boolean) {
      fake.mirrorPositions = value;
    },
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
