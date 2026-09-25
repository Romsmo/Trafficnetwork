/**
 * Migration lock policy (add-on E-B; docs/operating.md "Migrations that take a heavy lock").
 *
 * drizzle's migrator applies every pending migration in ONE transaction, so a statement that
 * needs a strong lock on a big table (a stored-generated-column rewrite, a plain CREATE INDEX,
 * SET NOT NULL, ...) holds it until the whole batch commits, and CREATE INDEX CONCURRENTLY
 * cannot be used at all. Such a statement is acceptable — sometimes there is no online
 * alternative — but it must be a conscious, documented choice, because on a node with real
 * users it is a maintenance window. Every such statement on a table that already existed
 * therefore has to carry one of these comments in its statement chunk:
 *
 *   -- lock-ok(<table>): <why, and how long it takes>   heavy: the migrate step warns about it
 *   -- lock-trivial: <why it is cheap>                    accepted silently (tiny table, no rewrite)
 *
 * Statements on a table created earlier in the same migration are exempt (the table is empty).
 * tests/unit/migration-locks.test.ts enforces this for every migration from `LINT_FROM_INDEX` on.
 */

/** Migrations before this index shipped before the policy existed and are not linted. */
export const LINT_FROM_INDEX = 7;

/** drizzle-kit separates the statements of a migration file with this marker. */
export const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

export interface LockAnnotation {
  table: string;
  reason: string;
}

export interface LockFinding {
  /** Why the statement is considered lock-heavy. */
  pattern: string;
  /** The statement's first line, for the error message. */
  statement: string;
}

const HEAVY_ANNOTATION = /^--\s*lock-ok\(([A-Za-z0-9_."]+)\)\s*:\s*(.+)$/gm;
const HAS_HEAVY_ANNOTATION = /^--\s*lock-ok\([^)]*\)\s*:\s*\S/m;
const HAS_TRIVIAL_ANNOTATION = /^--\s*lock-trivial\s*:\s*\S/m;

/** Strips `--` comments, so annotations and prose never influence the pattern matching. */
function stripComments(chunk: string): string {
  return chunk
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

const unquote = (ident: string) => ident.replace(/"/g, "").replace(/^public\./, "");

export function splitStatements(migrationSql: string): string[] {
  return migrationSql
    .split(STATEMENT_BREAKPOINT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Every `lock-ok(table): reason` annotation of a migration file (what the migrate step prints). */
export function heavyLockAnnotations(migrationSql: string): LockAnnotation[] {
  return [...migrationSql.matchAll(HEAVY_ANNOTATION)].map((m) => ({
    table: unquote(m[1] ?? ""),
    reason: (m[2] ?? "").trim(),
  }));
}

const VOLATILE_DEFAULT = /\bdefault\s+\(?\s*(gen_random_uuid|uuid_generate_v\d|random|clock_timestamp|nextval|timeofday)\s*\(/i;

/**
 * Lock-heavy statements of one migration file that carry no annotation. A statement is heavy
 * when it can rewrite or scan a table that already holds rows, or blocks writes while it builds
 * an index, and its table was not created by the same file.
 */
export function unannotatedHeavyStatements(migrationSql: string): LockFinding[] {
  const chunks = splitStatements(migrationSql);
  const createdHere = new Set<string>();
  for (const chunk of chunks) {
    const m = /create\s+table\s+(?:if\s+not\s+exists\s+)?("?[\w.]+"?(?:\."?\w+"?)?)/i.exec(stripComments(chunk));
    if (m?.[1]) createdHere.add(unquote(m[1]));
  }

  const findings: LockFinding[] = [];
  for (const chunk of chunks) {
    const code = stripComments(chunk).replace(/\s+/g, " ").trim();
    if (code === "") continue;

    let table: string | undefined;
    let pattern: string | undefined;

    const alter = /^alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?("?[\w.]+"?(?:\."?\w+"?)?)\s+(.*)$/i.exec(code);
    if (alter) {
      table = unquote(alter[1] ?? "");
      const rest = alter[2] ?? "";
      if (/add\s+column[^;]*generated\s+always\s+as[^;]*stored/i.test(rest)) {
        pattern = "ADD COLUMN ... GENERATED ... STORED rewrites the whole table under ACCESS EXCLUSIVE";
      } else if (/add\s+column[^;]*\bnot\s+null\b/i.test(rest) && !/\bdefault\b/i.test(rest)) {
        pattern = "ADD COLUMN ... NOT NULL without a DEFAULT scans (or fails on) a non-empty table";
      } else if (VOLATILE_DEFAULT.test(rest)) {
        pattern = "ADD COLUMN with a volatile DEFAULT rewrites the whole table";
      } else if (/alter\s+column\s+"?\w+"?\s+(set\s+data\s+)?type\b/i.test(rest)) {
        pattern = "ALTER COLUMN TYPE usually rewrites the table";
      } else if (/alter\s+column\s+"?\w+"?\s+set\s+not\s+null/i.test(rest)) {
        pattern = "SET NOT NULL scans the table under ACCESS EXCLUSIVE (add a validated CHECK first)";
      } else if (/add\s+constraint[^;]*\b(foreign\s+key|check)\b/i.test(rest) && !/\bnot\s+valid\b/i.test(rest)) {
        pattern = "ADD CONSTRAINT without NOT VALID scans the table under lock (add NOT VALID, then VALIDATE CONSTRAINT)";
      } else if (/add\s+constraint[^;]*\b(unique|primary\s+key)\b/i.test(rest) && !/\busing\s+index\b/i.test(rest)) {
        pattern = "ADD CONSTRAINT UNIQUE/PRIMARY KEY builds an index under lock (create it CONCURRENTLY, then USING INDEX)";
      }
    }

    const index = /^create\s+(?:unique\s+)?index\s+(?!concurrently\b)(?:if\s+not\s+exists\s+)?"?\w+"?\s+on\s+(?:only\s+)?("?[\w.]+"?(?:\."?\w+"?)?)/i.exec(code);
    if (index) {
      table = unquote(index[1] ?? "");
      pattern = "CREATE INDEX without CONCURRENTLY blocks writes while it builds";
    }

    const dml = /^(?:update|delete\s+from)\s+(?:only\s+)?("?[\w.]+"?(?:\."?\w+"?)?)/i.exec(code);
    if (dml) {
      table = unquote(dml[1] ?? "");
      pattern = "UPDATE/DELETE inside the migration transaction locks every row it touches until the batch commits";
    }

    if (!pattern || !table || createdHere.has(table)) continue;
    if (HAS_HEAVY_ANNOTATION.test(chunk) || HAS_TRIVIAL_ANNOTATION.test(chunk)) continue;
    findings.push({ pattern, statement: code.slice(0, 140) });
  }
  return findings;
}

export interface PendingMigration {
  tag: string;
  sql: string;
}

/**
 * The warning the migrate step prints before it starts, so an operator watching the container log
 * (or wondering why the container is "unhealthy") knows what is happening and why. `null` when
 * none of the pending migrations carries a `lock-ok` annotation. `estimatedRows` gives the
 * planner's row estimate of a table, or null when it is unknown.
 */
export function heavyMigrationNotice(
  pending: PendingMigration[],
  estimatedRows: (table: string) => number | null,
): string | null {
  const blocks: string[] = [];
  for (const migration of pending) {
    const annotations = heavyLockAnnotations(migration.sql);
    for (const table of new Set(annotations.map((a) => a.table))) {
      const rows = estimatedRows(table);
      const size = rows === null ? "size unknown" : `about ${rows.toLocaleString("en-US")} rows`;
      const reasons = annotations.filter((a) => a.table === table).map((a) => `    - ${a.reason}`);
      blocks.push(`  ${migration.tag}: "${table}" (${size}) is locked while the migration runs\n${reasons.join("\n")}`);
    }
  }
  if (blocks.length === 0) return null;
  return [
    'WARNING: pending migrations take a heavy lock (docs/operating.md, "Migrations that take a heavy lock").',
    "The affected tables cannot be read or written, and the server cannot start, until they finish — do not interrupt them.",
    ...blocks,
  ].join("\n");
}
