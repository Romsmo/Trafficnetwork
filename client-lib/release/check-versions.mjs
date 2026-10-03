#!/usr/bin/env node
// Every package of the client library carries the version of the Rust
// workspace (client-lib/Cargo.toml). They are written down in a handful of
// manifests of five different tools; this fails if any of them disagrees, so a
// release cannot ship an npm package, a Python wheel and an AAR that each think
// they are a different version.
//
//     node client-lib/release/check-versions.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

/** First match of `pattern` (one capture group) in `file`. */
function find(file, pattern) {
  const match = pattern.exec(read(file));
  if (!match) throw new Error(`${file}: no version found (looked for ${pattern})`);
  return match[1];
}

const workspace = find("Cargo.toml", /\[workspace\.package\][^[]*?^version\s*=\s*"([^"]+)"/ms);
const found = {
  "Cargo.toml (workspace.package)": workspace,
  "bindings/dart/rust/Cargo.toml": find("bindings/dart/rust/Cargo.toml", /^version\s*=\s*"([^"]+)"/m),
  "bindings/node/package.json": JSON.parse(read("bindings/node/package.json")).version,
  "bindings/wasm/package.json": JSON.parse(read("bindings/wasm/package.json")).version,
  "bindings/python/pyproject.toml": find("bindings/python/pyproject.toml", /^version\s*=\s*"([^"]+)"/m),
  "bindings/dart/pubspec.yaml": find("bindings/dart/pubspec.yaml", /^version:\s*(\S+)/m),
  "bindings/flutter/pubspec.yaml": find("bindings/flutter/pubspec.yaml", /^version:\s*(\S+)/m),
  "bindings/flutter/ios/trafficnetwork_flutter.podspec": find(
    "bindings/flutter/ios/trafficnetwork_flutter.podspec",
    /s\.version\s*=\s*'([^']+)'/,
  ),
};

let failed = false;
for (const [file, version] of Object.entries(found)) {
  const same = version === workspace;
  if (!same) failed = true;
  console.log(`${same ? "ok  " : "FAIL"}  ${version.padEnd(8)} ${file}`);
}
if (failed) {
  console.error(`\nthe versions above must all be ${workspace}, the workspace's`);
  process.exit(1);
}
console.log(`\nall ${Object.keys(found).length} manifests say ${workspace}`);
