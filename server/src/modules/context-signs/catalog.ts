/**
 * The catalogue of signs a node accepts as context signs (docs/context-signs.md D1): the 58 signs the display project can draw
 * (Appendix A of the requirement; contract `sign-rules.json` of TN-DSP, protocol 1.0.0). Codes are country-prefixed catalogue
 * references like `static_signs.sign_type` (`DE:276`, `DE:142-10`); at the start only the German catalogue is known - another
 * country is added by giving it a catalogue here, not by changing anything else.
 *
 * The server stores and delivers raw entries. Which column a sign goes into and which signs replace each other (276 replaces
 * 277, 283 replaces 286, 282 ends 274/276/277) is a rule of the app (`sign-rules.json`), not of this file.
 */

export type SignClass = "prohibition" | "hazard";
export type ValueKind = "weight" | "length";

export interface SignValueRule {
  kind: ValueKind;
  unit: "t" | "m";
  required: boolean;
  min: number;
  max: number;
}

export interface SignInfo {
  /** Catalogue number without the country: `276`, `142-10`. */
  vz: string;
  class: SignClass;
  /** The longest stretch one entry of this sign may cover (metres). */
  maxLengthM: number;
  /** A sign that stands at one place (a crossing, an end sign): its shape is a few metres, never a long stretch. */
  pointLike: boolean;
  /** Only valid for a limited time: the entry must carry a period with an end, at most `maxPeriodDays` long. */
  maxPeriodDays: number | null;
  value: SignValueRule | null;
}

const POINT_MAX_M = 60;
const HAZARD_MAX_M = 3000;
const PROHIBITION_MAX_M = 20_000;

function hazard(vz: string, extra: Partial<SignInfo> = {}): SignInfo {
  return { vz, class: "hazard", maxLengthM: HAZARD_MAX_M, pointLike: false, maxPeriodDays: null, value: null, ...extra };
}
function prohibition(vz: string, extra: Partial<SignInfo> = {}): SignInfo {
  return { vz, class: "prohibition", maxLengthM: PROHIBITION_MAX_M, pointLike: false, maxPeriodDays: null, value: null, ...extra };
}
const point = { maxLengthM: POINT_MAX_M, pointLike: true };
const weight = (required: boolean): SignValueRule => ({ kind: "weight", unit: "t", required, min: 0.5, max: 100 });
const length = (required: boolean, max = 60): SignValueRule => ({ kind: "length", unit: "m", required, min: 0.5, max });

const SIGNS: readonly SignInfo[] = [
  // Gefahrzeichen
  hazard("101"),
  hazard("101-10", { maxLengthM: 5000 }),
  hazard("101-11", point),
  hazard("101-12"),
  hazard("101-13"),
  hazard("101-14", { maxLengthM: 5000 }),
  hazard("101-15"),
  hazard("101-51", { maxLengthM: 5000 }),
  hazard("101-52"),
  hazard("101-53"),
  hazard("101-54"),
  hazard("101-55", point),
  hazard("102", point),
  hazard("103-10"),
  hazard("105-10"),
  hazard("108-4", { maxLengthM: 5000 }),
  hazard("110-4", { maxLengthM: 5000 }),
  hazard("112"),
  hazard("114"),
  hazard("117-10"),
  hazard("120"),
  hazard("121-10"),
  hazard("123", { maxLengthM: 10_000, maxPeriodDays: 90 }),
  hazard("124", { maxLengthM: 5000, maxPeriodDays: 3 }),
  hazard("125", { maxLengthM: 5000 }),
  hazard("131", point),
  hazard("133-10", point),
  hazard("136-10"),
  hazard("138-10"),
  hazard("142-10", { maxLengthM: 5000 }),
  hazard("151", point),
  // Gebote und Verbote
  prohibition("250"),
  prohibition("251"),
  prohibition("253", { value: weight(false) }),
  prohibition("254"),
  prohibition("255"),
  prohibition("257-50"),
  prohibition("259"),
  prohibition("260"),
  prohibition("261"),
  prohibition("262-5", { value: weight(true) }),
  prohibition("263-8", { value: weight(true) }),
  prohibition("264-2", { value: length(true, 5) }),
  prohibition("265-3", { value: length(true, 10) }),
  prohibition("266-10", { value: length(true, 40) }),
  prohibition("267", point),
  prohibition("268"),
  prohibition("269"),
  prohibition("270", { maxLengthM: 5000 }),
  prohibition("272", { maxLengthM: HAZARD_MAX_M }),
  prohibition("273-70", { value: length(true, 200) }),
  prohibition("276"),
  prohibition("277"),
  prohibition("280", point),
  prohibition("281", point),
  prohibition("282", point),
  prohibition("283", { maxLengthM: 2000 }),
  prohibition("286", { maxLengthM: 2000 }),
];

const BY_VZ = new Map(SIGNS.map((s) => [s.vz, s]));

/** Catalogue prefix of a sign code (`DE`), and the number (`142-10`). */
const SIGN_CODE = /^([A-Z]{2}):([0-9]{3}(?:-[0-9]{1,2})?)$/;

export const CATALOG_COUNTRIES = ["DE"] as const;

/** The sign a code names, or null when the code is malformed, from a catalogue this node does not know, or not in it. */
export function signInfo(signType: string): (SignInfo & { country: string }) | null {
  const match = SIGN_CODE.exec(signType);
  if (!match) return null;
  const [, country, vz] = match;
  if (!(CATALOG_COUNTRIES as readonly string[]).includes(country!)) return null;
  const info = BY_VZ.get(vz!);
  return info ? { ...info, country: country! } : null;
}

/** Every code of the catalogue, e.g. `DE:276`, in catalogue order. */
export function allSignTypes(): string[] {
  return CATALOG_COUNTRIES.flatMap((country) => SIGNS.map((s) => `${country}:${s.vz}`));
}

export const SIGN_COUNT = SIGNS.length;
