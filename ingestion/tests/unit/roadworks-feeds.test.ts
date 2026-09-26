import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadFeeds, resolveEnabledFeeds, type FeedSwitches } from "../../src/pipeline/roadworks/feeds.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const switches = (over: Partial<FeedSwitches> = {}): FeedSwitches => ({ roadworksEnabled: true, feedsOn: [], feedsOff: [], env: {}, ...over });
const ids = (feeds: { id: string }[]) => feeds.map((f) => f.id);

describe("the shipped roadworks feed catalog (config/roadworks-feeds.json)", () => {
  const feeds = loadFeeds();

  it("loads, in priority order, with every legal field the importer records", () => {
    expect(ids(feeds)).toEqual(["fr-tipi-rrn", "nl-ndw", "de-autobahn"]);
    for (const feed of feeds) {
      expect(feed.sourceLicense.length).toBeGreaterThan(0);
      expect(feed.attribution.length).toBeGreaterThan(0);
      expect(feed.url).toMatch(/^https:\/\//);
    }
  });

  it("switches on only what is safe by default: the openly licensed French feed", () => {
    expect(ids(resolveEnabledFeeds(feeds, switches()))).toEqual(["fr-tipi-rrn"]);
  });

  it("keeps the feeds whose terms are not settled off (license 'ungeklärt' / unconfirmed)", () => {
    const byId = Object.fromEntries(feeds.map((f) => [f.id, f]));
    expect(byId["de-autobahn"]!.enabled).toBe(false);
    expect(byId["de-autobahn"]!.sourceLicense).toBe("ungeklärt");
    expect(byId["nl-ndw"]!.enabled).toBe(false);
  });

  it("the German feed also honours its own legacy switch AUTOBAHN_API_ENABLED, but only for the exact value 'true'", () => {
    expect(ids(resolveEnabledFeeds(feeds, switches({ env: { AUTOBAHN_API_ENABLED: "true" } })))).toEqual(["fr-tipi-rrn", "de-autobahn"]);
    expect(ids(resolveEnabledFeeds(feeds, switches({ env: { AUTOBAHN_API_ENABLED: "false" } })))).toEqual(["fr-tipi-rrn"]);
    expect(ids(resolveEnabledFeeds(feeds, switches({ env: { AUTOBAHN_API_ENABLED: "1" } })))).toEqual(["fr-tipi-rrn"]);
  });
});

describe("resolveEnabledFeeds", () => {
  const feeds = loadFeeds();

  it("ROADWORKS_FEEDS_ON turns a disabled feed on; ROADWORKS_FEEDS_OFF wins over every other switch", () => {
    expect(ids(resolveEnabledFeeds(feeds, switches({ feedsOn: ["nl-ndw"] })))).toEqual(["fr-tipi-rrn", "nl-ndw"]);
    expect(ids(resolveEnabledFeeds(feeds, switches({ feedsOff: ["fr-tipi-rrn"] })))).toEqual([]);
    expect(ids(resolveEnabledFeeds(feeds, switches({ feedsOn: ["de-autobahn"], feedsOff: ["de-autobahn"], env: { AUTOBAHN_API_ENABLED: "true" } })))).toEqual(["fr-tipi-rrn"]);
  });

  it("the global kill switch turns everything off", () => {
    expect(resolveEnabledFeeds(feeds, switches({ roadworksEnabled: false, feedsOn: ["nl-ndw"] }))).toEqual([]);
  });

  it("--feed narrows the run to the named feeds but does not enable a disabled one", () => {
    expect(ids(resolveEnabledFeeds(feeds, switches(), ["fr-tipi-rrn"]))).toEqual(["fr-tipi-rrn"]);
    expect(ids(resolveEnabledFeeds(feeds, switches(), ["nl-ndw"]))).toEqual([]);
    expect(ids(resolveEnabledFeeds(feeds, switches({ feedsOn: ["nl-ndw"] }), ["nl-ndw"]))).toEqual(["nl-ndw"]);
  });

  it("refuses an unknown feed id anywhere instead of silently doing nothing", () => {
    expect(() => resolveEnabledFeeds(feeds, switches({ feedsOn: ["nl-ndv"] }))).toThrow(/Unknown roadworks feed "nl-ndv" — known feeds: fr-tipi-rrn, nl-ndw, de-autobahn/);
    expect(() => resolveEnabledFeeds(feeds, switches(), ["typo"])).toThrow(/Unknown roadworks feed "typo"/);
  });
});

describe("loadFeeds validation", () => {
  const write = (content: unknown): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tn-feeds-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "feeds.json");
    fs.writeFileSync(file, JSON.stringify(content));
    return file;
  };

  it("adding a DATEX II country is a config entry: a valid extra feed loads and keeps file order", () => {
    const file = write({
      feeds: {
        "xx-test": { enabled: false, kind: "datex2", country: "XX", name: "n", url: "https://example.test/feed.xml", sourceLicense: "CC0", attribution: "a", minIntervalMinutes: 30 },
      },
    });
    expect(loadFeeds(file)).toEqual([expect.objectContaining({ id: "xx-test", kind: "datex2", minIntervalMinutes: 30 })]);
  });

  it("names the broken field and the file when an entry is invalid (missing license, bad id)", () => {
    const file = write({ feeds: { "Bad Id": { enabled: true, kind: "datex2", country: "XX", name: "n", url: "https://example.test/", attribution: "a", minIntervalMinutes: 30 } } });
    expect(() => loadFeeds(file)).toThrow(/Invalid roadworks feed config at .*feeds\.json/);
  });

  it("a feed without a sourceLicense is refused — provenance is mandatory", () => {
    const file = write({ feeds: { "xx-test": { enabled: true, kind: "datex2", country: "XX", name: "n", url: "https://example.test/", attribution: "a", minIntervalMinutes: 30 } } });
    expect(() => loadFeeds(file)).toThrow(/sourceLicense/);
  });
});
