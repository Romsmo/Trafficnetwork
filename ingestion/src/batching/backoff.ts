export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  maxRetries: number;
}

/** Full-jitter exponential backoff delay for retry attempt `attempt` (0-indexed). */
export function backoffDelayMs(attempt: number, options: BackoffOptions): number {
  const capped = Math.min(options.maxMs, options.baseMs * 2 ** attempt);
  return Math.floor(Math.random() * capped);
}

export function shouldRetry(attempt: number, options: BackoffOptions): boolean {
  return attempt < options.maxRetries;
}

/** Statuses worth retrying: transient server errors, and defensively 429 (see api/client.ts's doc comment on why bulk-import has no route-specific rate limit today but this stays defensive). */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parses a `Retry-After` header value (delta-seconds or an HTTP date) into a
 * delay in ms; undefined if absent or unparseable. Capped by the caller.
 */
export function parseRetryAfterMs(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/**
 * Runs `fn` with retry+backoff on retryable failures. `fn` should return a
 * result with a `status` the caller can check via `isRetryableFailure`, or
 * throw for a network-level failure (also retried). `serverDelayHintMs`, if
 * given, lets the server's own `Retry-After` raise (never lower) the wait
 * before the next attempt, still capped at `options.maxMs`.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  isRetryableFailure: (result: T) => boolean,
  options: BackoffOptions,
  onRetry?: (attempt: number, delayMs: number) => void,
  serverDelayHintMs?: (result: T) => number | undefined,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    let result: T;
    try {
      result = await fn(attempt);
    } catch (err) {
      if (!shouldRetry(attempt, options)) throw err;
      const delayMs = backoffDelayMs(attempt, options);
      onRetry?.(attempt, delayMs);
      await sleep(delayMs);
      attempt++;
      continue;
    }
    if (!isRetryableFailure(result) || !shouldRetry(attempt, options)) return result;
    const hint = serverDelayHintMs?.(result);
    const delayMs = hint === undefined ? backoffDelayMs(attempt, options) : Math.min(options.maxMs, Math.max(hint, backoffDelayMs(attempt, options)));
    onRetry?.(attempt, delayMs);
    await sleep(delayMs);
    attempt++;
  }
}
