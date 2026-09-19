import { cpSync, existsSync } from "node:fs";

// tsc only emits compiled .js — non-TS build assets (migration .sql files)
// need to be copied into dist/ manually so the compiled migrate.js (which
// resolves its migrations folder relative to its own file location, see
// src/db/migrate.ts) finds them at runtime.
const pairs = [["src/db/migrations", "dist/db/migrations"]];

for (const [from, to] of pairs) {
  if (!existsSync(from)) {
    throw new Error(`copy-build-assets: source path missing: ${from}`);
  }
  cpSync(from, to, { recursive: true });
}
