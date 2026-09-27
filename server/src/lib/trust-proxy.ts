/** Value for Fastify's `trustProxy` option, parsed from the TRUST_PROXY environment variable. */
export type TrustProxySetting = boolean | number | string[];

export function parseTrustProxy(value: string | undefined): TrustProxySetting {
  if (value === undefined) return false;
  const v = value.trim();
  if (v === "" || v.toLowerCase() === "false") return false;
  if (v.toLowerCase() === "true") return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
