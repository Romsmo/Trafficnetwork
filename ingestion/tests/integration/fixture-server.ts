import { createServer, type Server } from "node:http";
import fs, { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES_DIR = path.resolve(fileURLToPath(import.meta.url), "../../fixtures");

export interface FixtureServer {
  baseUrl: string;
  close: () => Promise<void>;
}

/** Serves tests/fixtures/*.osm.pbf (+ .md5 sidecars) over local HTTP, so the real download.ts code path (fetch extract, fetch checksum, verify) runs unmodified in tests instead of hitting the real Geofabrik. */
export async function startFixtureServer(): Promise<FixtureServer> {
  const server: Server = createServer((req, res) => {
    const requestedPath = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    const filePath = path.join(FIXTURES_DIR, requestedPath);
    if (!filePath.startsWith(FIXTURES_DIR) || !existsSync(filePath)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200);
    fs.createReadStream(filePath).pipe(res);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server failed to bind to a port");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
