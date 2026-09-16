import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

/** clientSecret is never stored — only this salted hash. Format: "<saltHex>:<hashHex>". */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(secret, salt, KEY_LENGTH)) as Buffer;
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

export async function verifySecret(secret: string, storedHash: string): Promise<boolean> {
  const [saltHex, hashHex] = storedHash.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const derived = (await scryptAsync(secret, salt, KEY_LENGTH)) as Buffer;
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

export function generateClientId(): string {
  return `client_${randomBytes(8).toString("hex")}`;
}

export function generateClientSecret(): string {
  return randomBytes(32).toString("base64url");
}
