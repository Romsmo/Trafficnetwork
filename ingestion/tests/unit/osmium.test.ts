import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filterAndSplit, OSM_TAG_FILTER } from "../../src/pipeline/osm/osmium.js";

const silentLogger = pino({ level: "silent" });
const osmiumInstalled = await osmiumIsInstalled();

describe("filterAndSplit", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "osmium-test-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  // This CI/dev environment doesn't necessarily have osmium-tool installed
  // (it's a system binary, see docs/sources.md) — this test only exercises
  // the ENOENT guidance path, which doesn't require osmium to actually exist.
  // If osmium IS installed, this test is skipped rather than failing on an
  // unrelated real invocation error.
  it.skipIf(osmiumInstalled)("gives an actionable error when osmium-tool isn't on PATH", async () => {
    await expect(filterAndSplit(path.join(workDir, "nonexistent.osm.pbf"), workDir, { tileDegrees: null, inputMd5: "x" }, silentLogger)).rejects.toThrow(/osmium-tool not found on PATH/);
  });

  it("filters on speed information and signs only — not on every highway", () => {
    expect(OSM_TAG_FILTER).toEqual(["w/maxspeed,maxspeed:type,source:maxspeed", "nw/traffic_sign", "n/highway=speed_camera"]);
    expect(OSM_TAG_FILTER.join(" ")).not.toContain("w/highway");
  });
});

async function osmiumIsInstalled(): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn("osmium", ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}
