import { describe, expect, it } from "vitest";
import { signToken, verifyToken, TokenVerificationError } from "../../src/modules/auth/jwt.js";
import { generateClientId, generateClientSecret, hashSecret, verifySecret } from "../../src/modules/auth/credentials.js";

const env = { JWT_SECRET: "a".repeat(32), JWT_TTL_SECONDS: 3600 };

describe("jwt sign/verify", () => {
  it("round-trips subject and scopes", async () => {
    const token = await signToken({ sub: "client_abc", scopes: ["client"] }, env);
    const claims = await verifyToken(token, env);
    expect(claims.sub).toBe("client_abc");
    expect(claims.scopes).toEqual(["client"]);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signToken({ sub: "client_abc", scopes: ["client"] }, env);
    await expect(verifyToken(token, { JWT_SECRET: "b".repeat(32) })).rejects.toThrow(TokenVerificationError);
  });

  it("rejects an expired token", async () => {
    const token = await signToken({ sub: "client_abc", scopes: ["client"] }, { ...env, JWT_TTL_SECONDS: -1 });
    await expect(verifyToken(token, env)).rejects.toThrow(TokenVerificationError);
  });

  it("rejects a malformed token", async () => {
    await expect(verifyToken("not-a-jwt", env)).rejects.toThrow(TokenVerificationError);
  });
});

describe("credential hashing", () => {
  it("verifies the correct secret against its hash", async () => {
    const secret = generateClientSecret();
    const hash = await hashSecret(secret);
    expect(await verifySecret(secret, hash)).toBe(true);
  });

  it("rejects an incorrect secret", async () => {
    const hash = await hashSecret(generateClientSecret());
    expect(await verifySecret("wrong-secret", hash)).toBe(false);
  });

  it("generates unique client ids and secrets", () => {
    expect(generateClientId()).not.toBe(generateClientId());
    expect(generateClientSecret()).not.toBe(generateClientSecret());
  });
});
