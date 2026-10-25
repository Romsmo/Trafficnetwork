/**
 * The time zone a context sign's time windows are read in (docs/context-signs.md D3): the local time of the place. For a country
 * with one zone it follows from the country; where the boundary data is not loaded (or a country has several zones) the node's
 * CONTEXT_SIGNS_DEFAULT_TIMEZONE is proposed and the proposer may change it - within CONTEXT_SIGNS_TIMEZONE_PREFIXES.
 * Europe first: the table holds the European countries; more are added when a node opens another part of the world.
 */
const EUROPE: Record<string, string> = {
  AL: "Europe/Tirane", AD: "Europe/Andorra", AT: "Europe/Vienna", BY: "Europe/Minsk", BE: "Europe/Brussels", BA: "Europe/Sarajevo",
  BG: "Europe/Sofia", CH: "Europe/Zurich", CY: "Asia/Nicosia", CZ: "Europe/Prague", DE: "Europe/Berlin", DK: "Europe/Copenhagen",
  EE: "Europe/Tallinn", ES: "Europe/Madrid", FI: "Europe/Helsinki", FR: "Europe/Paris", GB: "Europe/London", GR: "Europe/Athens",
  HR: "Europe/Zagreb", HU: "Europe/Budapest", IE: "Europe/Dublin", IS: "Atlantic/Reykjavik", IT: "Europe/Rome", LI: "Europe/Vaduz",
  LT: "Europe/Vilnius", LU: "Europe/Luxembourg", LV: "Europe/Riga", MC: "Europe/Monaco", MD: "Europe/Chisinau", ME: "Europe/Podgorica",
  MK: "Europe/Skopje", MT: "Europe/Malta", NL: "Europe/Amsterdam", NO: "Europe/Oslo", PL: "Europe/Warsaw", PT: "Europe/Lisbon",
  RO: "Europe/Bucharest", RS: "Europe/Belgrade", SE: "Europe/Stockholm", SI: "Europe/Ljubljana", SK: "Europe/Bratislava",
  SM: "Europe/San_Marino", UA: "Europe/Kyiv", XK: "Europe/Belgrade",
};

/** The zone of a country, or null when the table does not know it. */
export function timezoneOfCountry(iso2: string | null): string | null {
  return iso2 ? (EUROPE[iso2.toUpperCase()] ?? null) : null;
}

/** The zone to propose: the country's if it is accepted here, else the node's default. */
export function proposeTimezone(iso2: string | null, prefixes: readonly string[], fallback: string): string {
  const tz = timezoneOfCountry(iso2);
  return tz && prefixes.some((p) => tz.startsWith(p)) ? tz : fallback;
}
