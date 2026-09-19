import { writeFileSync } from "node:fs";

/**
 * Exports GET /v1/network/directory from a running, federating server as a
 * static JSON file — for mirroring on static hosting (GitHub Pages or
 * similar) alongside the live endpoint, per the F-S0 plan's decision 6
 * ("eigener Modus des bestehenden Servers... zusätzlich als statische
 * JSON-Datei exportierbar"). Plain HTTP fetch, not a DB connection — this
 * runs from an operator's machine against their own server's public URL,
 * the same data anyone else could already read from that endpoint.
 *
 * Usage:
 *   npm run network:export-directory -- --url https://your-server.example [--out ./directory.json]
 */

interface Args {
  url: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };

  const url = get("--url");
  if (!url) throw new Error("--url <server base url> is required");

  return { url: url.replace(/\/$/, ""), out: get("--out") ?? "./directory.json" };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const res = await fetch(`${args.url}/v1/network/directory`);
  if (!res.ok) {
    throw new Error(`GET ${args.url}/v1/network/directory responded ${res.status}`);
  }
  const directory = (await res.json()) as { peers?: unknown[] };

  writeFileSync(args.out, JSON.stringify(directory, null, 2));
  console.log(`Directory (${directory.peers?.length ?? 0} peers) exported to ${args.out}.`);
}

main().catch((err) => {
  console.error("Failed to export directory:", err);
  process.exit(1);
});
