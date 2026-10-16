import { describe, expect, it } from "vitest";
import { createPlaceSearch, parsePlaces, PlaceSearchError, type Fetcher } from "../../src/modules/places/search.js";
import { labelRest } from "../../web/public/assets/js/place-search.js";

const nominatim = (items: unknown[]) => async () => ({ ok: true, status: 200, json: async () => items });

const POSTAU = {
  place_id: 1,
  osm_type: "relation",
  osm_id: 4711,
  lat: "48.5961",
  lon: "12.1923",
  display_name: "Postau, Landkreis Landshut, Bayern, 84103, Deutschland",
  name: "Postau",
  type: "administrative",
  boundingbox: ["48.55", "48.64", "12.15", "12.25"],
};

describe("places: reading a geocoder answer", () => {
  it("keeps what is a place, with the box turned into [west, south, east, north]", () => {
    const [place] = parsePlaces([POSTAU], 6);
    expect(place).toEqual({
      id: "r4711",
      name: "Postau",
      label: "Postau, Landkreis Landshut, Bayern, 84103, Deutschland",
      lat: 48.5961,
      lng: 12.1923,
      kind: "administrative",
      bbox: [12.15, 48.55, 12.25, 48.64],
    });
  });

  it("leaves out what is not usable: no position, an impossible position, no text, a repeat", () => {
    const places = parsePlaces(
      [
        POSTAU,
        { ...POSTAU },
        { ...POSTAU, osm_id: 2, lat: "abc" },
        { ...POSTAU, osm_id: 3, lat: "95", lon: "12" },
        { ...POSTAU, osm_id: 4, display_name: "" },
        null,
        "text",
        { ...POSTAU, osm_id: 5, boundingbox: ["1", "0", "2", "3"] },
      ],
      6,
    );
    expect(places.map((p) => p.id)).toEqual(["r4711", "r5"]);
    expect(places[1]!.bbox).toBeNull(); // south above north: no box, but the place itself is fine
  });

  it("names a place after the first part of its line when the service gives no name, and stops at the limit", () => {
    const items = Array.from({ length: 9 }, (_, i) => ({ ...POSTAU, osm_id: 10 + i, name: undefined, display_name: `Ort ${i}, Bayern` }));
    const places = parsePlaces(items, 6);
    expect(places).toHaveLength(6);
    expect(places[0]!.name).toBe("Ort 0");
    expect(parsePlaces({ not: "an array" }, 6)).toEqual([]);
  });

  it("the page shows the rest of the line under the name", () => {
    expect(labelRest({ name: "Postau", label: "Postau, Landkreis Landshut, Bayern" })).toBe("Landkreis Landshut, Bayern");
    expect(labelRest({ name: "Postau", label: "Postau" })).toBe("");
    expect(labelRest({ name: "Haus", label: "Straße 1, Postau" })).toBe("Straße 1, Postau");
  });
});

describe("places: asking the service politely", () => {
  function setup(answer: Fetcher = nominatim([POSTAU]) as unknown as Fetcher) {
    const requests: { url: string; headers: Record<string, string> }[] = [];
    let clock = 1_000_000;
    const sleeps: number[] = [];
    const fetcher: Fetcher = async (url, init) => {
      requests.push({ url, headers: init.headers });
      return answer(url, init);
    };
    const search = createPlaceSearch({
      url: "https://geocoder.example/search",
      userAgent: "test-agent (+https://example.org)",
      timeoutMs: 1000,
      minIntervalMs: 1100,
      cacheTtlMs: 60_000,
      fetcher,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    return { search, requests, sleeps, advance: (ms: number) => (clock += ms) };
  }

  it("sends an identifying user agent, the term, the language and a soft preference for the map area - never a hard limit", async () => {
    const { search, requests } = setup();
    await search({ q: "  Postau  ", near: { lat: 48.6, lng: 12.2 }, lang: "en" });
    const url = new URL(requests[0]!.url);
    expect(url.origin + url.pathname).toBe("https://geocoder.example/search");
    expect(url.searchParams.get("q")).toBe("Postau");
    expect(url.searchParams.get("format")).toBe("jsonv2");
    expect(url.searchParams.get("accept-language")).toBe("en,de");
    expect(url.searchParams.get("viewbox")).toBe("11.7000,49.1000,12.7000,48.1000");
    expect(url.searchParams.get("bounded")).toBeNull();
    expect(requests[0]!.headers["user-agent"]).toBe("test-agent (+https://example.org)");
  });

  it("answers the same search twice with one request, also when both come at once", async () => {
    const { search, requests } = setup();
    const [a, b] = await Promise.all([search({ q: "Postau" }), search({ q: "postau" })]);
    expect(a).toEqual(b);
    await search({ q: "Postau  " });
    expect(requests).toHaveLength(1);
  });

  it("asks again after the answer has grown old", async () => {
    const { search, requests, advance } = setup();
    await search({ q: "Postau" });
    advance(61_000);
    await search({ q: "Postau" });
    expect(requests).toHaveLength(2);
  });

  it("keeps the service's pace: two different searches are never less than the minimum apart", async () => {
    const { search, sleeps } = setup();
    await search({ q: "Postau" });
    await search({ q: "Weng" });
    await search({ q: "Moosthann" });
    expect(sleeps).toEqual([1100, 1100]);
  });

  it("says plainly when the service fails, and does not remember the failure", async () => {
    let fail = true;
    const answer: Fetcher = async () => (fail ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, status: 200, json: async () => [POSTAU] });
    const { search } = setup(answer);
    await expect(search({ q: "Postau" })).rejects.toBeInstanceOf(PlaceSearchError);
    fail = false;
    expect((await search({ q: "Postau" })).map((p) => p.name)).toEqual(["Postau"]);
  });

  it("a service that cannot be reached is the same kind of error", async () => {
    const { search } = setup(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(search({ q: "Postau" })).rejects.toThrow("could not be reached");
  });
});
