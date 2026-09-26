import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { backoffDelayMs, isRetryableStatus, parseRetryAfterMs, type BackoffOptions } from "../../batching/backoff.js";
import type { Logger } from "../../logging.js";

export const USER_AGENT = "Trafficnetwork-ingestion/0.1 (+https://github.com/Romsmo/Trafficnetwork; roadworks import)";

export interface HttpOptions {
  timeoutMs: number;
  backoff: BackoffOptions;
  /** For tests. */
  fetchImpl?: typeof fetch;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET with the etiquette a public feed deserves: an identifying User-Agent, a hard timeout, and backoff on 429/5xx that
 * honours the server's `Retry-After`. Any other non-2xx is a real answer (404, 403, …) and is returned as an error at once.
 */
export async function politeGet(url: string, options: HttpOptions, logger: Logger): Promise<Response> {
  const doFetch = options.fetchImpl ?? fetch;
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    let failure: string | undefined;
    try {
      res = await doFetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/xml, application/json, */*;q=0.5" }, signal: AbortSignal.timeout(options.timeoutMs), redirect: "follow" });
      if (res.ok) return res;
      failure = `HTTP ${res.status}`;
      if (!isRetryableStatus(res.status)) {
        await res.body?.cancel().catch(() => {});
        throw new PermanentHttpError(`GET ${url} failed: HTTP ${res.status}`);
      }
    } catch (err) {
      if (err instanceof PermanentHttpError) throw err;
      failure = err instanceof Error ? err.message : String(err);
    }
    if (attempt >= options.backoff.maxRetries) throw new Error(`GET ${url} failed after ${attempt + 1} attempts: ${failure}`);
    await res?.body?.cancel().catch(() => {});
    const hint = parseRetryAfterMs(res?.headers.get("retry-after"));
    const delay = hint === undefined ? backoffDelayMs(attempt, options.backoff) : Math.min(options.backoff.maxMs, Math.max(hint, backoffDelayMs(attempt, options.backoff)));
    logger.warn({ url, attempt: attempt + 1, delayMs: delay, failure }, "roadworks feed request failed — retrying");
    await sleep(delay);
  }
}

export class PermanentHttpError extends Error {}

/**
 * The response body as text chunks, gunzipped if it is gzip. Detected by the gzip magic number, not by URL or headers: NDW serves
 * `.xml.gz` as plain `application/xml` without `Content-Encoding`, while other servers compress transparently (which fetch undoes itself).
 */
export async function* bodyChunks(res: Response): AsyncGenerator<Uint8Array> {
  if (!res.body) return;
  const source = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  const iterator = source[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) return;
  const head = first.value as Buffer;
  const rest = (async function* () {
    yield head;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value as Buffer;
    }
  })();
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
    const gunzip = createGunzip();
    Readable.from(rest).pipe(gunzip);
    for await (const chunk of gunzip) yield chunk as Buffer;
  } else {
    yield* rest;
  }
}
