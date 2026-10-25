import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { z } from "zod";
import { haversineMeters, projectOnSegment } from "../roads/geo.js";
import { signInfo } from "./catalog.js";

/**
 * The descriptor of a context sign (docs/context-signs.md D2): everything that says what an entry is - the sign, the stretch it
 * covers, the direction, when it applies, an optional value. It is what a device signs and what is replicated between nodes,
 * stored as signed; its hash is the entry's identity, so the same proposal means the same entry on every node.
 */

export interface TimeWindow {
  /** ISO weekdays, 1 = Monday ... 7 = Sunday. */
  days: number[];
  /** Local wall-clock times "HH:MM". `from > to` crosses midnight and belongs to the day it starts on. */
  from: string;
  to: string;
}

export interface Validity {
  v: 1;
  /** IANA zone the windows and dates are read in (the local time of the place). */
  tz: string;
  windows?: TimeWindow[];
  /** Local calendar dates, inclusive. `to: null` = "until revoked" (such an entry needs confirmations to stay, docs D5). */
  period?: { from: string; to: string | null };
}

export type Direction = "along" | "both";

export interface ContextSignDescriptor {
  v: 1;
  /** `DE:276` - a country-prefixed catalogue reference. */
  signType: string;
  /** [lng, lat] vertices at 1e-7 degrees, in the direction the sign applies in ("along") or canonical order ("both"). */
  geometry: [number, number][];
  direction: Direction;
  validity: Validity;
  value: number | null;
  unit: "t" | "m" | null;
}

export class DescriptorError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const windowSchema = z
  .object({
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    from: z.string().regex(TIME),
    to: z.string().regex(TIME),
  })
  .strict();

const validitySchema = z
  .object({
    v: z.literal(1),
    tz: z.string().min(3).max(64),
    windows: z.array(windowSchema).min(1).max(8).optional(),
    period: z.object({ from: z.string().regex(DATE), to: z.string().regex(DATE).nullable() }).strict().optional(),
  })
  .strict();

export const descriptorSchema = z
  .object({
    v: z.literal(1),
    signType: z.string().min(4).max(16),
    geometry: z.array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])).min(2).max(300),
    direction: z.enum(["along", "both"]),
    validity: validitySchema,
    value: z.number().finite().nullable(),
    unit: z.enum(["t", "m"]).nullable(),
  })
  .strict();

export interface DescriptorLimits {
  /** The IANA zone prefixes a node accepts (`Europe/`); other zones are refused until the operator allows them. */
  timezonePrefixes: readonly string[];
}

const round7 = (n: number) => Math.round(n * 1e7) / 1e7;
const microDegrees = (n: number) => Math.round(n * 1e7);

export function lineLengthM(geometry: readonly [number, number][]): number {
  let total = 0;
  for (let i = 1; i < geometry.length; i++) total += haversineMeters(geometry[i - 1]!, geometry[i]!);
  return total;
}

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Days between two ISO dates (UTC arithmetic: only the difference matters). */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function validDate(date: string): boolean {
  const t = Date.parse(`${date}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().startsWith(date);
}

function fwdKey(geometry: readonly [number, number][]): string {
  return geometry.map(([lng, lat]) => `${microDegrees(lng)},${microDegrees(lat)}`).join(";");
}

/**
 * The normal form of a descriptor: coordinates rounded to 1e-7 degrees, a stretch without direction in canonical orientation
 * (the shorter of the two orderings as text, like `segmentKey`), windows sorted and days unique, no empty optional parts.
 * Two descriptors that say the same thing normalise to the same object - and so to the same key.
 */
export function normaliseDescriptor(input: ContextSignDescriptor): ContextSignDescriptor {
  let geometry = input.geometry.map(([lng, lat]) => [round7(lng), round7(lat)] as [number, number]);
  // consecutive duplicates add nothing
  geometry = geometry.filter((p, i) => i === 0 || p[0] !== geometry[i - 1]![0] || p[1] !== geometry[i - 1]![1]);
  if (input.direction === "both") {
    const reversed = [...geometry].reverse();
    if (fwdKey(reversed) < fwdKey(geometry)) geometry = reversed;
  }
  const validity: Validity = { v: 1, tz: input.validity.tz };
  if (input.validity.windows && input.validity.windows.length > 0) {
    const windows = input.validity.windows.map((w) => ({ days: [...new Set(w.days)].sort((a, b) => a - b), from: w.from, to: w.to }));
    windows.sort((a, b) => (a.days.join() + a.from + a.to < b.days.join() + b.from + b.to ? -1 : 1));
    validity.windows = windows;
  }
  if (input.validity.period) validity.period = { from: input.validity.period.from, to: input.validity.period.to };
  return {
    v: 1,
    signType: input.signType,
    geometry,
    direction: input.direction,
    validity,
    value: input.value === null ? null : Math.round(input.value * 10) / 10,
    unit: input.value === null ? null : input.unit,
  };
}

/** The identity of an entry: 32 hex characters of the SHA-256 of the canonical (RFC 8785) normal form. */
export function entryKeyOf(descriptor: ContextSignDescriptor): string {
  const normal = normaliseDescriptor(descriptor);
  const text = canonicalize({ ...normal, geometry: normal.geometry.map(([lng, lat]) => [microDegrees(lng), microDegrees(lat)]) });
  return createHash("sha256").update(text ?? "").digest("hex").slice(0, 32);
}

export const ENTRY_KEY_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Checks a descriptor against the catalogue and the plausibility rules (docs D8) and returns its normal form. Throws a
 * DescriptorError with a machine-readable code. Pure: no road data here - whether the shape lies on a road is the API's business.
 */
export function validateDescriptor(raw: unknown, limits: DescriptorLimits): ContextSignDescriptor {
  const parsed = descriptorSchema.safeParse(raw);
  if (!parsed.success) throw new DescriptorError("INVALID_DESCRIPTOR", `Not a valid descriptor: ${parsed.error.issues[0]?.path.join(".") ?? ""} ${parsed.error.issues[0]?.message ?? ""}`.trim());
  const descriptor = normaliseDescriptor(parsed.data);

  const sign = signInfo(descriptor.signType);
  if (!sign) throw new DescriptorError("UNKNOWN_SIGN", "This sign is not in the catalogue of this node");

  if (descriptor.geometry.length < 2) throw new DescriptorError("INVALID_GEOMETRY", "The stretch needs at least two different points");
  const lengthM = lineLengthM(descriptor.geometry);
  if (lengthM < 2) throw new DescriptorError("INVALID_GEOMETRY", "The stretch is too short");
  if (lengthM > sign.maxLengthM) {
    throw new DescriptorError("STRETCH_TOO_LONG", `A ${descriptor.signType} may cover at most ${sign.maxLengthM} m (this one: ${Math.round(lengthM)} m)`);
  }
  for (let i = 1; i < descriptor.geometry.length; i++) {
    if (haversineMeters(descriptor.geometry[i - 1]!, descriptor.geometry[i]!) > 2500) {
      throw new DescriptorError("INVALID_GEOMETRY", "Two neighbouring points of the stretch are too far apart for a road");
    }
  }

  // value
  const rule = sign.value;
  if (rule) {
    if (descriptor.value === null) {
      if (rule.required) throw new DescriptorError("VALUE_REQUIRED", `A ${descriptor.signType} needs its value (${rule.unit})`);
    } else {
      if (descriptor.unit !== rule.unit) throw new DescriptorError("INVALID_VALUE", `The value of a ${descriptor.signType} is in ${rule.unit}`);
      if (descriptor.value < rule.min || descriptor.value > rule.max) {
        throw new DescriptorError("INVALID_VALUE", `The value of a ${descriptor.signType} must be between ${rule.min} and ${rule.max} ${rule.unit}`);
      }
    }
  } else if (descriptor.value !== null) {
    throw new DescriptorError("INVALID_VALUE", `A ${descriptor.signType} carries no value`);
  }

  // validity
  const { validity } = descriptor;
  if (!validZone(validity.tz) || !limits.timezonePrefixes.some((prefix) => validity.tz.startsWith(prefix))) {
    throw new DescriptorError("INVALID_TIMEZONE", "This time zone is not accepted by this node");
  }
  for (const w of validity.windows ?? []) {
    if (w.from === w.to) throw new DescriptorError("INVALID_WINDOW", "A time window must not start and end at the same time (leave windows out for all day)");
  }
  if (validity.period) {
    const { from, to } = validity.period;
    if (!validDate(from) || (to !== null && !validDate(to))) throw new DescriptorError("INVALID_PERIOD", "The period holds a date that does not exist");
    if (to !== null && to < from) throw new DescriptorError("INVALID_PERIOD", "The period ends before it starts");
    if (to !== null && daysBetween(from, to) > 3660) throw new DescriptorError("INVALID_PERIOD", "The period is longer than ten years");
  }
  if (sign.maxPeriodDays !== null) {
    const p = validity.period;
    if (!p || p.to === null) throw new DescriptorError("PERIOD_REQUIRED", `A ${descriptor.signType} is temporary: it needs a period with an end`);
    if (daysBetween(p.from, p.to) + 1 > sign.maxPeriodDays) {
      throw new DescriptorError("PERIOD_TOO_LONG", `A ${descriptor.signType} may be entered for at most ${sign.maxPeriodDays} days at a time`);
    }
  }
  return descriptor;
}

export interface ValidatedDescriptor {
  descriptor: ContextSignDescriptor;
  entryKey: string;
  lengthM: number;
  signClass: "prohibition" | "hazard";
}

export function describeDescriptor(raw: unknown, limits: DescriptorLimits): ValidatedDescriptor {
  const descriptor = validateDescriptor(raw, limits);
  return {
    descriptor,
    entryKey: entryKeyOf(descriptor),
    lengthM: Math.round(lineLengthM(descriptor.geometry)),
    signClass: signInfo(descriptor.signType)!.class,
  };
}

/** Two stretches this close (metres) are the same piece of road for the purpose of finding similar entries. */
export const SIMILAR_TOLERANCE_M = 15;

/**
 * The share (0..1) of line `a` that lies within `toleranceM` of line `b`, measured at points every few metres along `a`. Plain
 * geometry on the shapes - no database function - so it is the same everywhere and easy to test.
 */
export function overlapShare(a: readonly [number, number][], b: readonly [number, number][], toleranceM: number): number {
  const total = lineLengthM(a);
  if (total === 0) return 0;
  const step = Math.max(2, total / 200);
  let near = 0;
  let samples = 0;
  for (let i = 1; i < a.length; i++) {
    const from = a[i - 1]!;
    const to = a[i]!;
    const length = haversineMeters(from, to);
    const n = Math.max(1, Math.ceil(length / step));
    for (let k = 0; k < n; k++) {
      const f = (k + 0.5) / n;
      const p: [number, number] = [from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f];
      let nearest = Infinity;
      for (let j = 1; j < b.length && nearest > toleranceM; j++) nearest = Math.min(nearest, projectOnSegment(p, b[j - 1]!, b[j]!).distanceM);
      samples++;
      if (nearest <= toleranceM) near++;
    }
  }
  return samples === 0 ? 0 : near / samples;
}
