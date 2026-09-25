import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LINT_FROM_INDEX,
  heavyLockAnnotations,
  heavyMigrationNotice,
  unannotatedHeavyStatements,
} from "../../src/db/migration-locks.js";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src/db/migrations");

/** Wraps statements the way drizzle-kit writes a migration file. */
const migration = (...statements: string[]) => statements.join("\n--> statement-breakpoint\n");

describe("migration lock policy", () => {
  it("every migration from the policy on annotates its lock-heavy statements", () => {
    const files = readdirSync(migrationsDir)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    const linted = files.filter((f) => Number(f.slice(0, 4)) >= LINT_FROM_INDEX);
    expect(linted.length).toBeGreaterThan(0);
    for (const file of linted) {
      const findings = unannotatedHeavyStatements(readFileSync(path.join(migrationsDir, file), "utf8"));
      expect(findings, `${file}: annotate with "-- lock-ok(<table>): <why, how long>" or "-- lock-trivial: <why>"`).toEqual([]);
    }
  });

  it("migration 0007 declares its segment-table rewrite as heavy (the migrate step warns about it)", () => {
    const sql = readFileSync(path.join(migrationsDir, "0007_speed_limit_corrections.sql"), "utf8");
    const tables = heavyLockAnnotations(sql).map((a) => a.table);
    expect(tables).toContain("speed_limit_segments");
  });

  describe("detection", () => {
    const flagged = (sql: string) => unannotatedHeavyStatements(migration(sql)).map((f) => f.pattern);

    it("flags a stored generated column, a plain CREATE INDEX and an unbounded UPDATE on an existing table", () => {
      expect(flagged('ALTER TABLE "big" ADD COLUMN "k" text GENERATED ALWAYS AS (f(x)) STORED;')).toEqual([
        expect.stringContaining("GENERATED"),
      ]);
      expect(flagged('CREATE INDEX "big_k_idx" ON "big" USING btree ("k");')).toEqual([expect.stringContaining("CONCURRENTLY")]);
      expect(flagged('CREATE UNIQUE INDEX "big_k_uq" ON "public"."big" ("k");')).toEqual([expect.stringContaining("CONCURRENTLY")]);
      expect(flagged('UPDATE "big" SET "k" = 1;')).toEqual([expect.stringContaining("UPDATE")]);
      expect(flagged('DELETE FROM "big";')).toEqual([expect.stringContaining("DELETE")]);
    });

    it("flags the constraint and column changes that scan or rewrite the table", () => {
      expect(flagged('ALTER TABLE "big" ADD COLUMN "k" integer NOT NULL;')).toHaveLength(1);
      expect(flagged('ALTER TABLE "big" ADD COLUMN "id2" uuid DEFAULT gen_random_uuid();')).toHaveLength(1);
      expect(flagged('ALTER TABLE "big" ALTER COLUMN "k" SET DATA TYPE bigint;')).toHaveLength(1);
      expect(flagged('ALTER TABLE "big" ALTER COLUMN "k" TYPE bigint;')).toHaveLength(1);
      expect(flagged('ALTER TABLE "big" ALTER COLUMN "k" SET NOT NULL;')).toHaveLength(1);
      expect(flagged('ALTER TABLE "big" ADD CONSTRAINT "c" CHECK ("k" > 0);')).toHaveLength(1);
      expect(flagged('ALTER TABLE "big" ADD CONSTRAINT "fk" FOREIGN KEY ("k") REFERENCES "other"("id");')).toHaveLength(1);
      expect(flagged('ALTER TABLE "big" ADD CONSTRAINT "u" UNIQUE ("k");')).toHaveLength(1);
    });

    it("accepts the online forms", () => {
      expect(flagged('CREATE INDEX CONCURRENTLY "big_k_idx" ON "big" ("k");')).toEqual([]);
      expect(flagged('ALTER TABLE "big" ADD COLUMN "k" integer;')).toEqual([]);
      expect(flagged('ALTER TABLE "big" ADD COLUMN "k" integer DEFAULT 0 NOT NULL;')).toEqual([]);
      expect(flagged('ALTER TABLE "big" ADD COLUMN "seen" timestamp with time zone DEFAULT now() NOT NULL;')).toEqual([]);
      expect(flagged('ALTER TABLE "big" ADD CONSTRAINT "c" CHECK ("k" > 0) NOT VALID;')).toEqual([]);
      expect(flagged('ALTER TABLE "big" ADD CONSTRAINT "u" UNIQUE USING INDEX "big_k_idx";')).toEqual([]);
      expect(flagged('ALTER TABLE "big" DROP COLUMN "k";')).toEqual([]);
    });

    it("exempts tables the same migration creates (they are empty)", () => {
      const sql = migration(
        'CREATE TABLE "fresh" ("id" integer PRIMARY KEY, "k" text);',
        'CREATE INDEX "fresh_k_idx" ON "fresh" USING btree ("k");',
        'ALTER TABLE "fresh" ADD COLUMN "g" text GENERATED ALWAYS AS (upper(k)) STORED;',
        'INSERT INTO "fresh" ("id") VALUES (1);',
        'UPDATE "fresh" SET "k" = \'x\';',
      );
      expect(unannotatedHeavyStatements(sql)).toEqual([]);
    });

    it("accepts a statement that carries an annotation and reads the heavy ones", () => {
      const sql = migration(
        '-- lock-ok(big): rewrites the table, about 20 s per million rows\nALTER TABLE "big" ADD COLUMN "k" text GENERATED ALWAYS AS (f(x)) STORED;',
        '-- lock-trivial: one row\nUPDATE "state" SET "v" = 1;',
      );
      expect(unannotatedHeavyStatements(sql)).toEqual([]);
      expect(heavyLockAnnotations(sql)).toEqual([{ table: "big", reason: "rewrites the table, about 20 s per million rows" }]);
    });

    it("does not let an annotation in one statement cover the next one", () => {
      const sql = migration(
        '-- lock-ok(big): rewrite\nALTER TABLE "big" ADD COLUMN "k" text GENERATED ALWAYS AS (f(x)) STORED;',
        'CREATE INDEX "big_k_idx" ON "big" ("k");',
      );
      expect(unannotatedHeavyStatements(sql)).toHaveLength(1);
    });

    it("ignores a heavy-looking statement that only appears in a comment", () => {
      expect(flagged('-- CREATE INDEX "x" ON "big" ("k");\nSELECT 1;')).toEqual([]);
    });
  });

  describe("heavyMigrationNotice", () => {
    const heavy = migration(
      '-- lock-ok(speed_limit_segments): rewrites the table, about 20 s per million rows\nALTER TABLE "speed_limit_segments" ADD COLUMN "k" text GENERATED ALWAYS AS (f(x)) STORED;',
      '-- lock-ok(speed_limit_segments): index built in the same transaction\nCREATE INDEX "i" ON "speed_limit_segments" ("k");',
    );

    it("is null when nothing pending is heavy", () => {
      expect(heavyMigrationNotice([{ tag: "0001_x", sql: 'CREATE TABLE "a" ("id" integer);' }], () => 5)).toBeNull();
      expect(heavyMigrationNotice([], () => null)).toBeNull();
    });

    it("names the migration, the table, its size and every reason, once per table", () => {
      const notice = heavyMigrationNotice([{ tag: "0007_speed_limit_corrections", sql: heavy }], () => 14_800_000);
      expect(notice).toContain("0007_speed_limit_corrections");
      expect(notice).toContain('"speed_limit_segments" (about 14,800,000 rows)');
      expect(notice).toContain("rewrites the table, about 20 s per million rows");
      expect(notice).toContain("index built in the same transaction");
      expect(notice!.match(/is locked while the migration runs/g)).toHaveLength(1);
    });

    it("says so when the size is unknown", () => {
      const notice = heavyMigrationNotice([{ tag: "0007_x", sql: heavy }], () => null);
      expect(notice).toContain("size unknown");
    });
  });
});
