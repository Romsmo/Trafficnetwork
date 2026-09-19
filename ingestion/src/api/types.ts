/**
 * Row shapes mirrored 1:1 from server/src/modules/bulk-import/routes.ts —
 * keep these in sync with that file, not with server/docs/api.md (the docs
 * are a description of the code, the code is the actual contract).
 *
 * Coordinate-order footgun, load-bearing: speed-limit-segment lineStrings use
 * [lng, lat] tuples (GeoJSON order), while static-signs and speed-cameras use
 * separate named lat/lng fields. This is the server's actual API, not a
 * inconsistency this package gets to fix — normalize.ts (P3.2) is the one
 * place that must get this right.
 */

export interface SpeedLimitSegmentRow {
  lineString: [number, number][];
  speedLimit: number;
  speedLimitUnit: "kmh" | "mph";
  source: string;
  sourceLicense?: string;
  importedAt?: string;
}

export interface StaticSignRow {
  lat: number;
  lng: number;
  signType: string;
  source: string;
  sourceLicense?: string;
  importedAt?: string;
}

export interface FixedSpeedCameraRow {
  lat: number;
  lng: number;
  source: string;
  sourceLicense?: string;
  importedAt?: string;
}

export type BulkImportKind = "speed-limit-segment" | "static-sign" | "fixed-speed-camera";

export const BULK_IMPORT_KINDS: BulkImportKind[] = ["speed-limit-segment", "static-sign", "fixed-speed-camera"];

export type BulkImportRow<K extends BulkImportKind> = K extends "speed-limit-segment"
  ? SpeedLimitSegmentRow
  : K extends "static-sign"
    ? StaticSignRow
    : FixedSpeedCameraRow;

export const BULK_IMPORT_ENDPOINT: Record<BulkImportKind, string> = {
  "speed-limit-segment": "/v1/bulk-import/speed-limit-segments",
  "static-sign": "/v1/bulk-import/static-signs",
  "fixed-speed-camera": "/v1/bulk-import/speed-cameras",
};

export interface BulkImportResponse {
  inserted: number;
}

/** The narrow slice of ApiClient that pipeline/run-worker.ts depends on — kept separate from the concrete class so tests can pass a lightweight fake instead of a real HTTP-backed instance. */
export interface BulkImportPoster {
  postBatch<K extends BulkImportKind>(kind: K, rows: BulkImportRow<K>[]): Promise<BulkImportResponse>;
}

export interface TokenResponse {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  scopes: string[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface NearbySpeedLimitSegment {
  speedLimit: number;
  speedLimitUnit: "kmh" | "mph";
  [key: string]: unknown;
}

export interface StaticDataManifest {
  staticDataVersion: number;
  generatedAt: string;
  partitions: { tile: string; hash: string; sizeBytes: number }[];
}

export interface StaticDataPartition {
  tile: string;
  speedLimitSegments: unknown[];
  staticSigns: unknown[];
  fixedSpeedCameras: unknown[];
}
