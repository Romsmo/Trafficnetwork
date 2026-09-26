import { backoffDelayMs, isRetryableStatus, parseRetryAfterMs, type BackoffOptions } from "../batching/backoff.js";
import type { Logger } from "../logging.js";

export const USER_AGENT = "Trafficnetwork-ingestion/0.1 (+https://github.com/Romsmo/Trafficnetwork)";

export interface HttpOptions {
  timeoutMs: number;
  backoff: BackoffOptions;
  /** Extra request headers (they win over the defaults: `accept`, and the identifying `user-agent` of the tool). */
  headers?: Record<string, string>;
  /** For tests. */
  fetchImpl?: typeof fetch;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET with the etiquette a public data service deserves: an identifying User-Agent, a hard timeout, and backoff on 429/5xx that
 * honours the server's `Retry-After`. Any other non-2xx is a real answer (404, 403, …) and is returned as an error at once.
 */
export async function politeGet(url: string, options: HttpOptions, logger: Logger): Promise<Response> {
  const doFetch = options.fetchImpl ?? fetch;
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    let failure: string | undefined;
    try {
      res = await doFetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/xml, application/json, */*;q=0.5", ...options.headers }, signal: AbortSignal.timeout(options.timeoutMs), redirect: "follow" });
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
    logger.warn({ url, attempt: attempt + 1, delayMs: delay, failure }, "request failed — retrying");
    await sleep(delay);
  }
}

export class PermanentHttpError extends Error {}

