import { z } from "zod";
import { HAZARD_TYPES } from "../config/constants.js";
import { badRequest } from "./errors.js";

/** Parses a comma-separated query param into a trimmed, non-empty string array (or undefined if absent). */
export function parseCsv(value: unknown): string[] | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parts = value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return parts.length > 0 ? parts : undefined;
}

const hazardTypeSchema = z.enum(HAZARD_TYPES);

export function parseHazardTypes(value: unknown): (typeof HAZARD_TYPES)[number][] | undefined {
  const raw = parseCsv(value);
  if (!raw) return undefined;
  const result = z.array(hazardTypeSchema).safeParse(raw);
  if (!result.success) {
    throw badRequest(`Invalid types filter: ${raw.join(",")}`, result.error.issues);
  }
  return result.data;
}

/** Radius bounds for *~/nearby endpoints — prevents an accidental (or abusive) whole-continent scan. */
const NEARBY_MAX_RADIUS_METERS = 50_000;

export function parseRadiusM(value: unknown): number {
  const result = z.coerce.number().positive().max(NEARBY_MAX_RADIUS_METERS).safeParse(value);
  if (!result.success) {
    throw badRequest(`radiusM must be a positive number up to ${NEARBY_MAX_RADIUS_METERS}`, result.error.issues);
  }
  return result.data;
}

export function parseLatLng(query: Record<string, unknown>): { lat: number; lng: number } {
  const schema = z.object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
  });
  const result = schema.safeParse(query);
  if (!result.success) {
    throw badRequest("lat and lng query parameters are required and must be valid coordinates", result.error.issues);
  }
  return result.data;
}
