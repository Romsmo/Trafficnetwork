import { describe, expect, it } from "vitest";
import { installRawSqlTypeParsers } from "../../src/db/raw-sql-types.js";

/**
 * Root-cause fix for the two JSON-shape bugs found by client-lib's multi-node tests
 * (see the retired status log (git history)): raw-SQL reads (`db.execute(sql\`...\`)`, used throughout
 * `db/queries/*.ts`) returned bigint columns as a JSON string and timestamptz columns
 * as Postgres's own text form instead of RFC 3339. Both are fixed by re-registering
 * postgres.js's OID parser table (see raw-sql-types.ts for the full root-cause writeup);
 * this test exercises exactly that registration without needing a real database.
 */

interface FakeClient {
  options: { parsers: Record<number, (value: string) => unknown> };
}

function fakeClient(): FakeClient {
  return { options: { parsers: {} } };
}

describe("installRawSqlTypeParsers", () => {
  it("registers a parser for exactly OID 20 (int8) and OID 1184 (timestamptz)", () => {
    const client = fakeClient();
    installRawSqlTypeParsers(client as never);
    expect(Object.keys(client.options.parsers).map(Number).sort((a, b) => a - b)).toEqual([20, 1184]);
  });

  it("OID 20 (int8/bigserial): converts Postgres's text form to a JS number", () => {
    const client = fakeClient();
    installRawSqlTypeParsers(client as never);
    const parse = client.options.parsers[20]!;
    expect(parse("1234")).toBe(1234);
    expect(parse("1234")).not.toBe("1234");
    expect(typeof parse("0")).toBe("number");
    // event_log.sequence style values, well within Number.MAX_SAFE_INTEGER for this project's scale.
    expect(parse("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("OID 1184 (timestamptz): converts Postgres's own text form to RFC 3339", () => {
    const client = fakeClient();
    installRawSqlTypeParsers(client as never);
    const parse = client.options.parsers[1184]!;
    expect(parse("2026-09-27 14:45:15.923718+00")).toBe("2026-09-27T14:45:15.923Z");
    // Already round, and a non-UTC offset — both must normalize to the same "Z" form.
    expect(parse("2026-01-01 00:00:00+00")).toBe("2026-01-01T00:00:00.000Z");
    expect(parse("2026-01-01 01:00:00+01")).toBe("2026-01-01T00:00:00.000Z");
  });

  it("is idempotent — installing twice keeps the same, single parser per OID", () => {
    const client = fakeClient();
    installRawSqlTypeParsers(client as never);
    installRawSqlTypeParsers(client as never);
    expect(Object.keys(client.options.parsers)).toHaveLength(2);
    expect(client.options.parsers[20]!("5")).toBe(5);
  });
});
