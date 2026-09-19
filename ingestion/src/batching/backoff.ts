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
 * Runs `fn` with retry+backoff on retryable failures. `fn` should return a
 * result with a `status` the caller can check via `isRetryableFailure`, or
 * throw for a network-level failure (also retried).
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  isRetryableFailure: (result: T) => boolean,
  options: BackoffOptions,
  onRetry?: (attempt: number, delayMs: number) => void,
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
    const delayMs = backoffDelayMs(attempt, options);
    onRetry?.(attempt, delayMs);
    await sleep(delayMs);
    attempt++;
  }
}
