import { gzipSync } from "node:zlib";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { bodyChunks, politeGet, USER_AGENT, type HttpOptions } from "../../src/pipeline/roadworks/fetch.js";

const silentLogger = pino({ level: "silent" });
const FAST = { baseMs: 1, maxMs: 5, maxRetries: 3 };
const http = (fetchImpl: typeof fetch): HttpOptions => ({ timeoutMs: 5000, backoff: FAST, fetchImpl });

async function collect(res: Response): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of bodyChunks(res)) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts).toString("utf8");
}

describe("politeGet", () => {
  it("identifies itself and follows redirects", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    await politeGet("https://example.test/feed", http(fetchImpl as unknown as typeof fetch), silentLogger);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.test/feed");
    expect((init.headers as Record<string, string>)["user-agent"]).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/Trafficnetwork-ingestion/);
    expect(init.redirect).toBe("follow");
  });

  it("retries a 503 and a 429 and then succeeds", async () => {
    const answers = [new Response("", { status: 503 }), new Response("", { status: 429, headers: { "retry-after": "0" } }), new Response("fine")];
    const fetchImpl = vi.fn(async () => answers.shift()!);
    const res = await politeGet("https://example.test/feed", http(fetchImpl as unknown as typeof fetch), silentLogger);
    expect(await res.text()).toBe("fine");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("retries a network error, and gives up after maxRetries with the reason", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNRESET");
    });
    await expect(politeGet("https://example.test/feed", http(fetchImpl as unknown as typeof fetch), silentLogger)).rejects.toThrow(/failed after 4 attempts: connect ECONNRESET/);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("does not retry a real answer such as 404 or 403", async () => {
    for (const status of [404, 403]) {
      const fetchImpl = vi.fn(async () => new Response("", { status }));
      await expect(politeGet("https://example.test/feed", http(fetchImpl as unknown as typeof fetch), silentLogger)).rejects.toThrow(new RegExp(`HTTP ${status}`));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
});

describe("bodyChunks", () => {
  const xml = '<?xml version="1.0"?><a>' + "x".repeat(50_000) + "</a>";

  it("passes plain text through", async () => {
    expect(await collect(new Response(xml))).toBe(xml);
  });

  it("gunzips by the gzip magic number, even though the server declares no Content-Encoding (as NDW does for .xml.gz)", async () => {
    const res = new Response(gzipSync(Buffer.from(xml)), { headers: { "content-type": "application/xml" } });
    expect(await collect(res)).toBe(xml);
  });

  it("an empty body yields nothing", async () => {
    expect(await collect(new Response(""))).toBe("");
  });
});
