import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGeojsonSeq } from "../../src/pipeline/osm/geojsonseq-reader.js";

const RS = "";

describe("readGeojsonSeq", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "geojsonseq-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("strips the RFC 8142 record separator and parses each line", async () => {
    const filePath = path.join(dir, "test.geojsonseq");
    const feature1 = { type: "Feature", properties: { "@type": "way", "@id": 1 }, geometry: { type: "LineString", coordinates: [[0, 0]] } };
    const feature2 = { type: "Feature", properties: { "@type": "node", "@id": 2 }, geometry: { type: "Point", coordinates: [1, 1] } };
    writeFileSync(filePath, `${RS}${JSON.stringify(feature1)}\n${RS}${JSON.stringify(feature2)}\n`);

    const features = [];
    for await (const f of readGeojsonSeq(filePath)) features.push(f);

    expect(features).toEqual([feature1, feature2]);
  });

  it("skips blank lines", async () => {
    const filePath = path.join(dir, "test.geojsonseq");
    const feature = { type: "Feature", properties: { "@type": "way", "@id": 1 }, geometry: { type: "LineString", coordinates: [[0, 0]] } };
    writeFileSync(filePath, `${RS}${JSON.stringify(feature)}\n\n\n`);

    const features = [];
    for await (const f of readGeojsonSeq(filePath)) features.push(f);

    expect(features).toEqual([feature]);
  });

  it("handles an empty file", async () => {
    const filePath = path.join(dir, "empty.geojsonseq");
    writeFileSync(filePath, "");

    const features = [];
    for await (const f of readGeojsonSeq(filePath)) features.push(f);

    expect(features).toEqual([]);
  });
});
