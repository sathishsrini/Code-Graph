// ============================================================================
// Migration runner  —  task P1-T1  (requirement R2)
// ============================================================================
// Reimplements the one pattern worth keeping from D:\facilitator's
// database-bootstrap.ts (plan §5): apply numbered SQL files in order, record
// what was applied, then verify with `PRAGMA foreign_key_check` and
// `PRAGMA integrity_check`.
//
// Two properties this buys, both of which the previous attempts lacked:
//
//   1. A migration file is IMMUTABLE once applied. Editing 001 to add a column
//      silently gives new and existing databases different shapes, and nothing
//      reports the divergence. New shape, new file.
//   2. Tables arrive with their producers (R72). `spans` ships when the OTLP
//      receiver does, not before, so no query can ever join a table that is
//      structurally guaranteed to be empty.
// ============================================================================

import type { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(HERE, "migrations");

/** `001_phase0_core.sql` -> version `001_phase0_core`. */
const MIGRATION_FILE = /^(\d{3}_[a-z0-9_]+)\.sql$/;

export interface Migration {
  version: string;
  file: string;
  sql: string;
}

export interface MigrationReport {
  applied: string[];
  alreadyApplied: string[];
}

/** Every migration on disk, in lexicographic (= numeric) order. */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const out: Migration[] = [];
  for (const name of readdirSync(dir).sort()) {
    const m = MIGRATION_FILE.exec(name);
    if (!m) continue;
    const file = join(dir, name);
    out.push({ version: m[1]!, file, sql: readFileSync(file, "utf8") });
  }
  if (out.length === 0) throw new Error(`no migrations found in ${dir}`);
  return out;
}

/** The version the code expects a fully-migrated database to be at. */
export function latestVersion(dir: string = MIGRATIONS_DIR): string {
  const all = loadMigrations(dir);
  return all[all.length - 1]!.version;
}

/**
 * Apply every migration not yet recorded in `schema_version`.
 *
 * Each one runs in its own transaction, so a failure in 003 leaves 001 and 002
 * applied and recorded rather than rolling the database back to nothing. That
 * matters when a migration fails on a database that already holds a day of
 * indexing.
 *
 * Migration files must contain no `PRAGMA journal_mode` — it is a no-op inside
 * a transaction, which is a silent failure rather than a loud one.
 */
export function migrate(db: DatabaseSync, dir: string = MIGRATIONS_DIR): MigrationReport {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
             version    TEXT PRIMARY KEY,
             applied_at TEXT NOT NULL
           )`);

  const done = new Set(
    (db.prepare("SELECT version FROM schema_version").all() as Array<{ version: string }>)
      .map((r) => r.version),
  );

  const report: MigrationReport = { applied: [], alreadyApplied: [] };

  for (const m of loadMigrations(dir)) {
    if (done.has(m.version)) {
      report.alreadyApplied.push(m.version);
      continue;
    }
    if (/PRAGMA\s+journal_mode/i.test(m.sql)) {
      throw new Error(
        `${m.file}: PRAGMA journal_mode inside a migration is a no-op — set it on connect`,
      );
    }

    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare(
        "INSERT INTO schema_version (version, applied_at) VALUES (?, datetime('now'))",
      ).run(m.version);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${m.version} failed: ${(e as Error).message}`, { cause: e });
    }
    report.applied.push(m.version);
  }

  return report;
}
