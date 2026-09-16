import { signToken } from "../../src/modules/auth/jwt.js";
import type { ClientScope } from "../../src/config/constants.js";
import type { Env } from "../../src/config/env.js";

/**
 * Issues a JWT directly (bypassing the clients table / token endpoint entirely)
 * since tests only need *some* validly-signed token with the right scopes and
 * subject — not a full client-provisioning round trip.
 */
export async function testToken(env: Pick<Env, "JWT_SECRET" | "JWT_TTL_SECONDS">, opts: { sub?: string; scopes?: ClientScope[] } = {}): Promise<string> {
  return signToken({ sub: opts.sub ?? "test-client", scopes: opts.scopes ?? ["client"] }, env);
}

export function authHeader(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}
