import type { Env } from "../config/env.js";
import type { Logger } from "../logging.js";
import { withRetry, isRetryableStatus, parseRetryAfterMs } from "../batching/backoff.js";
import {
  BULK_IMPORT_ENDPOINT,
  type ApiErrorBody,
  type BulkImportKind,
  type BulkImportResponse,
  type BulkImportRow,
  type NearbySpeedLimitSegment,
  type SeedReportsRequest,
  type SeedReportsResponse,
  type StaticDataManifest,
  type StaticDataPartition,
  type TokenResponse,
} from "./types.js";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: ApiErrorBody,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface CachedToken {
  accessToken: string;
  /** epoch ms; refreshed a bit before this to avoid racing an in-flight request against expiry. */
  expiresAt: number;
}

const TOKEN_REFRESH_MARGIN_MS = 30_000;

export class ApiClient {
  private token: CachedToken | undefined;

  constructor(
    private readonly env: Pick<Env, "SERVER_URL" | "CLIENT_ID" | "CLIENT_SECRET" | "HTTP_MAX_RETRIES" | "HTTP_BACKOFF_BASE_MS" | "HTTP_BACKOFF_MAX_MS">,
    private readonly logger: Logger,
  ) {}

  /** Verifies credentials work and warms the token cache — used by `--dry-run` and at the start of a real run. */
  async authenticate(): Promise<void> {
    await this.getToken();
  }

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
      return this.token.accessToken;
    }
    const tokenUrl = new URL("/v1/auth/token", this.env.SERVER_URL);
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: this.env.CLIENT_ID, clientSecret: this.env.CLIENT_SECRET }),
    }).catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not reach server at ${tokenUrl} (SERVER_URL=${this.env.SERVER_URL}): ${reason}`);
    });
    if (!res.ok) {
      const body = await safeJson<ApiErrorBody>(res);
      throw new ApiError(`Authentication failed: ${res.status} ${body?.error?.message ?? res.statusText}`, res.status, body);
    }
    const data = (await res.json()) as TokenResponse;
    this.token = { accessToken: data.accessToken, expiresAt: Date.now() + data.expiresIn * 1000 };
    return this.token.accessToken;
  }

  private backoffOptions() {
    return { baseMs: this.env.HTTP_BACKOFF_BASE_MS, maxMs: this.env.HTTP_BACKOFF_MAX_MS, maxRetries: this.env.HTTP_MAX_RETRIES };
  }

  private async authedFetch(pathname: string, init: RequestInit = {}): Promise<Response> {
    return withRetry(
      async () => {
        const token = await this.getToken();
        const url = new URL(pathname, this.env.SERVER_URL);
        return fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } }).catch((err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(`Could not reach server at ${url}: ${reason}`);
        });
      },
      (res) => isRetryableStatus(res.status),
      this.backoffOptions(),
      (attempt, delayMs) => this.logger.warn({ pathname, attempt, delayMs }, "retrying request after transient failure"),
      (res) => parseRetryAfterMs(res.headers.get("retry-after")),
    );
  }

  /** POSTs one batch (already capped at BATCH_SIZE / the server's 5000 hard cap by the caller). */
  async postBatch<K extends BulkImportKind>(kind: K, rows: BulkImportRow<K>[]): Promise<BulkImportResponse> {
    const res = await this.authedFetch(BULK_IMPORT_ENDPOINT[kind], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows }),
    });
    if (!res.ok) {
      const body = await safeJson<ApiErrorBody>(res);
      throw new ApiError(`Bulk import failed: ${res.status} ${body?.error?.message ?? res.statusText}`, res.status, body);
    }
    return (await res.json()) as BulkImportResponse;
  }

  /** Upserts one batch of seed reports (roadworks). Idempotent, so the generic retry-on-5xx is safe here. */
  async postSeedReports(request: SeedReportsRequest): Promise<SeedReportsResponse> {
    const res = await this.authedFetch("/v1/bulk-import/seed-reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      const body = await safeJson<ApiErrorBody>(res);
      throw new ApiError(`Seed-report import failed: ${res.status} ${body?.error?.message ?? res.statusText}`, res.status, body);
    }
    return (await res.json()) as SeedReportsResponse;
  }

  /** Ends a feed's reports that the given (complete) run did not re-send. */
  async retireSeedReports(feedId: string, runId: string): Promise<{ retired: number }> {
    const res = await this.authedFetch("/v1/bulk-import/seed-reports/retire", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ feedId, runId }),
    });
    if (!res.ok) {
      const body = await safeJson<ApiErrorBody>(res);
      throw new ApiError(`Seed-report retire failed: ${res.status} ${body?.error?.message ?? res.statusText}`, res.status, body);
    }
    return (await res.json()) as { retired: number };
  }

  async getNearbySpeedLimitSegments(lat: number, lng: number, radiusM: number): Promise<NearbySpeedLimitSegment[]> {
    const url = `/v1/speed-limit-segments/nearby?lat=${lat}&lng=${lng}&radiusM=${radiusM}`;
    const res = await this.authedFetch(url);
    if (!res.ok) throw new ApiError(`nearby lookup failed: ${res.status}`, res.status);
    return (await res.json()) as NearbySpeedLimitSegment[];
  }

  /**
   * True if the server holds no static data at all (no partition in the manifest). Used by the
   * import's "target must be empty" guard: the server has no dedup, so importing a region into a
   * server that already contains it would silently double it.
   */
  async isStaticDataEmpty(): Promise<boolean> {
    const manifest = await this.getStaticDataManifest();
    return manifest.partitions.length === 0;
  }

  async getStaticDataManifest(): Promise<StaticDataManifest> {
    const res = await this.authedFetch("/v1/static-data/manifest");
    if (!res.ok) throw new ApiError(`manifest fetch failed: ${res.status}`, res.status);
    return (await res.json()) as StaticDataManifest;
  }

  async getStaticDataPartition(tile: string): Promise<StaticDataPartition> {
    const res = await this.authedFetch(`/v1/static-data/partitions/${encodeURIComponent(tile)}`);
    if (!res.ok) throw new ApiError(`partition fetch failed: ${res.status}`, res.status);
    return (await res.json()) as StaticDataPartition;
  }
}

async function safeJson<T>(res: Response): Promise<T | undefined> {
  try {
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}
