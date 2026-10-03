#!/usr/bin/env node
// Assembles the two npm packages — @trafficnetwork/client-node and
// @trafficnetwork/client-web — as tarballs (`npm pack`) that stand on their
// own. In the repository both packages import the shared typed surface from
// `../shared`, a path that does not exist once a package is installed
// somewhere else; this script copies `shared/` into each package and points
// the two imports at the copy. Nothing else changes: the packaged sources are
// the repository's sources, and CI installs the tarballs into an empty project
// and runs the guides' examples from there.
//
//     node bindings/pack-npm.mjs [outDir]      (default: dist/npm)
//
// The web package also needs the WebAssembly build: run
// `wasm-pack build --target web --out-dir pkg` in bindings/wasm first.
//
// The packages stay `"private": true` — `npm pack` works, `npm publish`
// refuses. Publishing to a registry is a decision of its own.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bindings = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(bindings, "..", "..");
const out = path.resolve(process.argv[2] ?? "dist/npm");

function read(...parts) {
  return fs.readFileSync(path.join(...parts), "utf8");
}

function write(directory, name, text) {
  const file = path.join(directory, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** Replaces every occurrence of each `from` with its `to`; throws if one is missing (a silent no-op would ship a broken import). */
function rewrite(text, replacements, what) {
  let result = text;
  for (const [from, to] of replacements) {
    if (!result.includes(from)) throw new Error(`${what}: expected to find ${JSON.stringify(from)}`);
    result = result.split(from).join(to);
  }
  return result;
}

function copyShared(directory) {
  write(directory, "shared/index.js", read(bindings, "shared", "index.js"));
  write(directory, "shared/index.d.ts", read(bindings, "shared", "index.d.ts"));
}

function pack(directory) {
  execFileSync("npm", ["pack", "--pack-destination", out], {
    cwd: directory,
    stdio: ["ignore", "inherit", "inherit"],
    shell: process.platform === "win32",
  });
}

fs.rmSync(path.join(out, "stage"), { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// ----------------------------------------------------------------- Node.js

{
  const dir = path.join(out, "stage", "client-node");
  const manifest = JSON.parse(read(bindings, "node", "package.json"));
  manifest.files = ["index.js", "index.d.ts", "example.mjs", "shared/", "README.md", "LICENSE"];
  write(dir, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);
  const shared = [['"../shared/index.js"', '"./shared/index.js"']];
  write(dir, "index.js", rewrite(read(bindings, "node", "index.js"), shared, "node/index.js"));
  write(dir, "index.d.ts", rewrite(read(bindings, "node", "index.d.ts"), shared, "node/index.d.ts"));
  write(dir, "example.mjs", read(bindings, "node", "example.mjs"));
  copyShared(dir);
  write(dir, "LICENSE", read(repository, "LICENSE"));
  write(
    dir,
    "README.md",
    `# @trafficnetwork/client-node

The Trafficnetwork client for Node.js: FFI over the C ABI (\`libtrafficnetwork\`)
through [koffi](https://koffi.dev), with TypeScript types. Version ${manifest.version}.

This package does **not** contain the native library. Build it for your
platform (\`cargo build -p trafficnetwork-c-abi --release\` in \`client-lib/\`;
CI also attaches ready-made ones to every run) and point the package at it:
the \`libraryPath\` option, the \`TRAFFICNETWORK_LIB\` environment variable, or a
file next to \`index.js\`.

\`\`\`js
import { Client } from "@trafficnetwork/client-node";

const client = new Client({
  storagePath: "/var/lib/myapp/trafficnetwork",
  discovery: false,
  nodes: ["https://node.example.org"],
  credentials: { type: "client", clientId: "…", clientSecret: "…" },
});
await client.sync();
console.log(await client.getSpeedLimitAt(52.52, 13.405));
client.free();
\`\`\`

\`example.mjs\` in this package is a complete runnable version. Full guide:
\`client-lib/docs/integration-node.md\` in the repository
(https://github.com/Romsmo/Trafficnetwork).
`,
  );
  pack(dir);
}

// ----------------------------------------------------------------- browser

{
  const wasm = path.join(bindings, "wasm");
  const built = path.join(wasm, "pkg");
  if (!fs.existsSync(path.join(built, "trafficnetwork_wasm_bg.wasm"))) {
    throw new Error("bindings/wasm/pkg is missing: run `wasm-pack build --target web --out-dir pkg` in bindings/wasm first");
  }
  const dir = path.join(out, "stage", "client-web");
  const manifest = JSON.parse(read(wasm, "package.json"));
  manifest.main = "index.js";
  manifest.module = "index.js";
  manifest.types = "index.d.ts";
  manifest.sideEffects = false;
  manifest.files = ["index.js", "index.d.ts", "pkg/", "shared/", "example/", "README.md", "LICENSE"];
  write(dir, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);
  const imports = [
    ['"../pkg/trafficnetwork_wasm.js"', '"./pkg/trafficnetwork_wasm.js"'],
    ['"../../shared/index.js"', '"./shared/index.js"'],
  ];
  write(dir, "index.js", rewrite(read(wasm, "js", "index.js"), imports, "wasm/js/index.js"));
  write(
    dir,
    "index.d.ts",
    rewrite(read(wasm, "js", "index.d.ts"), [imports[1]], "wasm/js/index.d.ts"),
  );
  for (const name of [
    "trafficnetwork_wasm.js",
    "trafficnetwork_wasm.d.ts",
    "trafficnetwork_wasm_bg.wasm",
    "trafficnetwork_wasm_bg.wasm.d.ts",
  ]) {
    fs.mkdirSync(path.join(dir, "pkg"), { recursive: true });
    fs.copyFileSync(path.join(built, name), path.join(dir, "pkg", name));
  }
  copyShared(dir);
  write(
    dir,
    "example/index.html",
    rewrite(read(wasm, "example", "index.html"), [['"../js/index.js"', '"../index.js"']], "wasm/example/index.html"),
  );
  write(dir, "LICENSE", read(repository, "LICENSE"));
  write(
    dir,
    "README.md",
    `# @trafficnetwork/client-web

The Trafficnetwork client for the browser: the Rust core compiled to
WebAssembly, behind a small typed JavaScript module (the same surface as
\`@trafficnetwork/client-node\`). Version ${manifest.version}. Local data lives in IndexedDB.

\`\`\`html
<script type="module">
  import { Client } from "./node_modules/@trafficnetwork/client-web/index.js";

  const client = await Client.create({
    storagePath: "my-app", // the IndexedDB database name
    discovery: false,
    nodes: ["https://node.example.org"],
    credentials: { type: "client", clientId: "…", clientSecret: "…" },
  });
  await client.sync();
  console.log(await client.getSpeedLimitAt(52.52, 13.405));
</script>
\`\`\`

Bundlers (Vite, webpack, esbuild) take the package as it is. \`example/index.html\`
is a complete runnable page. What a browser cannot do — persistence trails
memory, one tab per database, secrets in \`localStorage\`, CORS — is listed in
\`client-lib/docs/integration-web.md\` in the repository
(https://github.com/Romsmo/Trafficnetwork).
`,
  );
  pack(dir);
}

console.log(`\ntarballs in ${out}:`);
for (const file of fs.readdirSync(out).filter((name) => name.endsWith(".tgz"))) console.log(`  ${file}`);
