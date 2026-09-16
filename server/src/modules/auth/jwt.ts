import { jwtVerify, SignJWT } from "jose";
import type { Env } from "../../config/env.js";
import type { ClientScope } from "../../config/constants.js";

export interface TokenClaims {
  sub: string;
  scopes: ClientScope[];
}

function secretKey(env: Pick<Env, "JWT_SECRET">): Uint8Array {
  return new TextEncoder().encode(env.JWT_SECRET);
}

export async function signToken(claims: TokenClaims, env: Pick<Env, "JWT_SECRET" | "JWT_TTL_SECONDS">): Promise<string> {
  return new SignJWT({ scopes: claims.scopes })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${env.JWT_TTL_SECONDS}s`)
    .sign(secretKey(env));
}

export class TokenVerificationError extends Error {}

export async function verifyToken(token: string, env: Pick<Env, "JWT_SECRET">): Promise<TokenClaims> {
  try {
    const { payload } = await jwtVerify(token, secretKey(env));
    if (typeof payload.sub !== "string" || !Array.isArray(payload["scopes"])) {
      throw new TokenVerificationError("Token payload missing sub or scopes");
    }
    return { sub: payload.sub, scopes: payload["scopes"] as ClientScope[] };
  } catch (err) {
    if (err instanceof TokenVerificationError) throw err;
    throw new TokenVerificationError("Invalid or expired token");
  }
}
