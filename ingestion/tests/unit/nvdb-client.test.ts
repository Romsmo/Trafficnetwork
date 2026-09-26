import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NvdbClient, RequestBudgetExhausted, type NvdbClientOptions } from "../../src/pipeline/nvdb/client.js";
import { startFakeNvdb, type FakeNvdb } from "../helpers/nvdb-fake-server.js";

const silentLogger = pino({ level: "silent" });

describe("NvdbClient against a fake serving real NVDB responses", () => {
  let fake: FakeNvdb;
  let sleeps: number[];

  beforeAll(async () => {
    fake = await startFakeNvdb();
  });
  afterAll(async () => {
    await fake.close();
  });
  beforeEach(() => {
    fake.requests.length = 0;
    fake.failMunicipalities.clear();
    fake.rateLimitRemaining = 199;
    sleeps = [];
  });

  const client = (over: Partial<NvdbClientOptions> = {}): NvdbClient =>
    new NvdbClient({
      baseUrl: fake.baseUrl,
      clientId: "Trafficnetwork-test",
      minRequestIntervalMs: 0,
      http: { timeoutMs: 5000, backoff: { baseMs: 1, maxMs: 5, maxRetries: 2 } },
      logger: silentLogger,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      ...over,
    });

  async function collect(gen: AsyncGenerator<unknown[]>): Promise<number[]> {
    const pages: number[] = [];
    for await (const page of gen) pages.push(page.length);
    return pages;
  }

  it("identifies itself: X-Client always, X-Kontaktperson when configured (the real API answers 400 without X-Client)", async () => {
    await client({ contact: "ops@example.test" }).municipalities();
    expect(fake.requests[0]!.headers["x-client"]).toBe("Trafficnetwork-test");
    expect(fake.requests[0]!.headers["x-kontaktperson"]).toBe("ops@example.test");
    expect(fake.requests[0]!.headers["user-agent"]).toMatch(/Trafficnetwork-ingestion/);

    fake.requests.length = 0;
    await client().municipalities();
    expect(fake.requests[0]!.headers["x-kontaktperson"]).toBeUndefined();
  });

  it("reads the municipalities in numeric order", async () => {
    expect((await client().municipalities()).map((k) => [k.nummer, k.navn])).toEqual([
      [301, "Oslo"],
      [1103, "Stavanger"],
      [1151, "Utsira"],
    ]);
  });

  it("reads the allowed Skiltnummer values as enum id → code (the text's first word, not the truncated kortnavn)", async () => {
    const { enumCodes } = await client().signPlateDefinition();
    expect(enumCodes.get(8874)).toBe("362.50");
    expect([...enumCodes.values()]).toContain("711.V135");
    expect([...enumCodes.values()]).not.toContain("711.V13");
  });

  it("reads the total number of plates of a municipality from the statistics endpoint", async () => {
    expect(await client().signPlateCount(1151)).toBe(32);
    expect(fake.requests[0]!.url.pathname).toBe("/vegobjekter/96/statistikk");
    expect(fake.requests[0]!.url.searchParams.get("kommune")).toBe("1151");
  });

  it("asks for WGS 84 (srid=4326) with properties and geometry, restricted to one municipality", async () => {
    await collect(client().signPlatePages(1151));
    const url = fake.requests[0]!.url;
    expect(url.pathname).toBe("/vegobjekter/96");
    expect(url.searchParams.get("kommune")).toBe("1151");
    expect(url.searchParams.get("srid")).toBe("4326");
    expect(url.searchParams.get("inkluder")).toBe("egenskaper,geometri");
    expect(url.searchParams.get("egenskap")).toBeNull();
  });

  it("passes the server-side Skiltnummer filter as enum ids when given", async () => {
    await collect(client().signPlatePages(1151, [8874, 8875, 202]));
    expect(fake.requests[0]!.url.searchParams.get("egenskap")).toBe("egenskap(5530)in[8874,8875,202]");
  });

  it("follows the cursor and stops on the API's real end-of-data answer: an empty page repeating the same cursor", async () => {
    expect(await collect(client().signPlatePages(1151))).toEqual([32]);
    const cursors = fake.requests.filter((r) => r.url.pathname === "/vegobjekter/96").map((r) => r.url.searchParams.get("start"));
    expect(cursors).toEqual([null, "816864518:1"]); // one page with data, then the empty one that ends it — not an endless loop

    fake.requests.length = 0;
    expect(await collect(client().signPlatePages(301))).toEqual([30, 30]);
    expect(fake.requests.map((r) => r.url.searchParams.get("start"))).toEqual([null, "86558599:4", "86558849:3"]);
  });

  it("a municipality without any plates ends at once (an empty page without a cursor)", async () => {
    expect(await collect(client().signPlatePages(1103))).toEqual([]);
    expect(fake.requests).toHaveLength(1);
  });

  it("spaces requests by minRequestIntervalMs", async () => {
    const c = client({ minRequestIntervalMs: 50, sleep: async (ms) => { sleeps.push(ms); await new Promise((r) => setTimeout(r, ms)); } });
    await c.municipalities();
    await c.municipalities();
    expect(sleeps.some((ms) => ms > 0 && ms <= 50)).toBe(true);
  });

  it("pauses when the published rate-limit budget runs low, and not otherwise", async () => {
    await client().municipalities();
    expect(sleeps).toEqual([]);

    fake.rateLimitRemaining = 3;
    await client().municipalities();
    expect(sleeps).toEqual([5000]);
  });

  it("stops cleanly when the per-run request budget is used up (the run resumes later)", async () => {
    const c = client({ maxRequests: 2 });
    await c.municipalities();
    await c.municipalities();
    await expect(c.municipalities()).rejects.toBeInstanceOf(RequestBudgetExhausted);
    expect(c.requestCount).toBe(2);
    expect(fake.requests).toHaveLength(2); // the refused request never reached the API
  });

  it("retries a service outage, then gives up with the reason", async () => {
    fake.failMunicipalities.add(1151);
    await expect(collect(client().signPlatePages(1151))).rejects.toThrow(/failed after 3 attempts: HTTP 503/);
    expect(fake.requests).toHaveLength(3);
  });
});
