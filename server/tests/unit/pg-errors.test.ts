import { describe, expect, it } from "vitest";
import { isUniqueViolation, pgErrorCode } from "../../src/lib/pg-errors.js";

describe("pg error codes", () => {
  it("reads the code from the error itself (postgres.js)", () => {
    expect(isUniqueViolation(Object.assign(new Error("dup"), { code: "23505" }))).toBe(true);
  });

  it("reads it from `.cause` — how drizzle-orm 0.45 wraps a failed query", () => {
    const driver = Object.assign(new Error('duplicate key value violates unique constraint "x"'), { code: "23505" });
    const wrapped = Object.assign(new Error("Failed query: insert …"), { cause: driver });
    expect(wrapped).not.toHaveProperty("code");
    expect(isUniqueViolation(wrapped)).toBe(true);
    expect(pgErrorCode(wrapped)).toBe("23505");
  });

  it("is false for other errors, other codes and non-errors", () => {
    expect(isUniqueViolation(Object.assign(new Error("x"), { code: "23503" }))).toBe(false);
    expect(isUniqueViolation(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(false);
    expect(isUniqueViolation(new Error("plain"))).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
  });

  it("does not loop on a cyclic cause chain", () => {
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(pgErrorCode(a)).toBeUndefined();
  });
});
