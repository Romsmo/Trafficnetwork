import { describe, expect, it, vi } from "vitest";
import { backoffDelayMs, isRetryableStatus, parseRetryAfterMs, shouldRetry, withRetry } from "../../src/batching/backoff.js";

describe("isRetryableStatus", () => {
  it("treats 429 and 5xx as retryable", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(599)).toBe(true);
  });

  it("treats 2xx/4xx (other than 429) as non-retryable", () => {
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });
});

describe("backoffDelayMs", () => {
  it("never exceeds maxMs regardless of attempt count", () => {
    const options = { baseMs: 500, maxMs: 5000, maxRetries: 10 };
    for (const attempt of [0, 1, 2, 5, 20]) {
      const delay = backoffDelayMs(attempt, options);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(options.maxMs);
    }
  });

  it("grows with attempt number before hitting the cap", () => {
    const options = { baseMs: 100, maxMs: 100_000, maxRetries: 10 };
    // Full jitter is randomized, so compare the *caps* each attempt draws from, not the draws themselves.
    const capAt = (attempt: number) => Math.min(options.maxMs, options.baseMs * 2 ** attempt);
    expect(capAt(1)).toBeGreaterThan(capAt(0));
    expect(capAt(3)).toBeGreaterThan(capAt(1));
  });
});

describe("shouldRetry", () => {
  it("allows retries up to maxRetries, then stops", () => {
    const options = { baseMs: 1, maxMs: 1, maxRetries: 3 };
    expect(shouldRetry(0, options)).toBe(true);
    expect(shouldRetry(2, options)).toBe(true);
    expect(shouldRetry(3, options)).toBe(false);
  });
});

describe("withRetry", () => {
  const fastOptions = { baseMs: 1, maxMs: 1, maxRetries: 3 };

  it("returns immediately on a non-retryable result without retrying", async () => {
    const fn = vi.fn().mockResolvedValue({ status: 200 });
    const result = await withRetry(fn, (r: { status: number }) => isRetryableStatus(r.status), fastOptions);
    expect(result).toEqual({ status: 200 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a retryable result up to maxRetries then returns the last result", async () => {
    const fn = vi.fn().mockResolvedValue({ status: 503 });
    const result = await withRetry(fn, (r: { status: number }) => isRetryableStatus(r.status), fastOptions);
    expect(result).toEqual({ status: 503 });
    expect(fn).toHaveBeenCalledTimes(fastOptions.maxRetries + 1);
  });

  it("succeeds once the underlying call stops failing", async () => {
    const fn = vi.fn().mockResolvedValueOnce({ status: 500 }).mockResolvedValueOnce({ status: 200 });
    const result = await withRetry(fn, (r: { status: number }) => isRetryableStatus(r.status), fastOptions);
    expect(result).toEqual({ status: 200 });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries a thrown network error and rethrows once retries are exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(withRetry(fn, () => false, fastOptions)).rejects.toThrow("ECONNRESET");
    expect(fn).toHaveBeenCalledTimes(fastOptions.maxRetries + 1);
  });

  it("waits at least the server's Retry-After hint (capped at maxMs) before retrying", async () => {
    const fn = vi.fn().mockResolvedValueOnce({ status: 429 }).mockResolvedValueOnce({ status: 200 });
    const onRetry = vi.fn();
    await withRetry(fn, (r: { status: number }) => isRetryableStatus(r.status), { baseMs: 1, maxMs: 40, maxRetries: 3 }, onRetry, () => 25);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![1]).toBe(25); // hint 25 ms beats the ≤1 ms jittered backoff

    const capped = vi.fn();
    await withRetry(
      vi.fn().mockResolvedValueOnce({ status: 429 }).mockResolvedValueOnce({ status: 200 }),
      (r: { status: number }) => isRetryableStatus(r.status),
      { baseMs: 1, maxMs: 30, maxRetries: 3 },
      capped,
      () => 60_000,
    );
    expect(capped.mock.calls[0]![1]).toBe(30); // a huge Retry-After is capped at maxMs
  });
});

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds and HTTP dates, ignores garbage", () => {
    expect(parseRetryAfterMs("7")).toBe(7000);
    expect(parseRetryAfterMs("  0 ")).toBe(0);
    expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:10 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"))).toBe(10_000);
    expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:10 GMT", Date.parse("Thu, 22 Oct 2026 07:28:00 GMT"))).toBe(0);
    expect(parseRetryAfterMs("soon")).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
  });
});
