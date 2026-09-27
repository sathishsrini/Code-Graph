// Tests for the SQL DDL extractor  —  slice CTX-S9  (goal G8; R11, R12, R28, R72)
//
// The gap this closes: `41-kri-engine/migrations/001_init.sql` sits inside the
// declared file set and was never read, because every extractor handled
// JS/TS/Python only. Tables existed only where a SQL string literal named
// them, and no column existed anywhere.
//
// The assertions are the plan's, plus the three properties that make the
// columns trustworthy rather than merely present:
//
//   one node per table   the migration's `users` and a literal's `users` are
//                        the same `datastore` node, or OPEN-9's join breaks
//   gaps are stored      a statement the extractor cannot model is a row with
//                        file:line, never a silent omission (R11)
//   provenance           re-indexing the migration replaces exactly its rows,
//                        and an unchanged migration is not touched (R28)
//
// The fixture is tests/fixtures/migrations/001_init.sql. Line numbers are
// found in it, never hand-counted.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FactStore } from "../src/store/db.ts";
import { indexRepo, type IndexReport } from "../src/index/pipeline.ts";
import { renderIndexReport } from "../src/index/report.ts";
import type { RepoConfig } from "../src/config/repos.ts";
import { readSql } from "../src/static/treesitter/extract.ts";
import { datastoreKey } from "../src/normalize/keys.ts";
import { extractDdl, isDdlFile } from "../src/static/ddl.ts";
import { listTables, renderTables } from "../src/query/tables.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FIXTURE = join(HERE, "fixtures", "migrations", "001_init.sql");
const FIXTURE_SQL = readFileSync(FIXTURE, "utf8");
const MIGRATION = "migrations/001_init.sql";

/** 1-based line of the first line containing `needle`. */
function lineOf(text: string, needle: string): number {
  const i = text.split(/\r?\n/).findIndex((l) => l.includes(needle));
  assert.notEqual(i, -1, `"${needle}" not in the text`);
  return i + 1;
}

const USERS_COLUMNS = [
  "id", "name", "email", "password_hash", "role", "created_at", "updated_at",
];

// ---------------------------------------------------------------------------
// The parser, on the fixture
// ---------------------------------------------------------------------------

describe("DDL extraction (CTX-S9)", () => {
  const f = extractDdl(MIGRATION, FIXTURE_SQL);
  const cols = (table: string) => f.columns.filter((c) => c.table === table);

  test("users has exactly the plan's seven columns, in declared order", () => {
    const users = cols("users").filter((c) => c.statement === "create_table");
    assert.deepEqual(users.map((c) => c.name), USERS_COLUMNS);
    assert.deepEqual(users.map((c) => c.position), [1, 2, 3, 4, 5, 6, 7]);
    // Each column is located at its own line, inside the CREATE TABLE.
    const create = lineOf(FIXTURE_SQL, "CREATE TABLE IF NOT EXISTS users");
    assert.ok(users.every((c) => c.statementLine === create));
    assert.equal(users[3]!.line, lineOf(FIXTURE_SQL, "password_hash VARCHAR"));
  });

  test("declared type, NOT NULL and PRIMARY KEY are read per column", () => {
    const byName = new Map(cols("users").map((c) => [c.name, c]));
    assert.equal(byName.get("id")!.dataType, "SERIAL");
    assert.equal(byName.get("id")!.primaryKey, true);
    assert.equal(byName.get("email")!.dataType, "VARCHAR(255)");
    assert.equal(byName.get("email")!.notNull, true);
    assert.equal(byName.get("created_at")!.dataType, "TIMESTAMP WITH TIME ZONE");
    assert.equal(byName.get("created_at")!.notNull, false);
  });

  test("table-level constraints are not columns", () => {
    const po = cols("purchase_orders").filter((c) => c.statement === "create_table");
    assert.deepEqual(
      po.map((c) => c.name),
      ["id", "po_number", "user_id", "amount", "status", "created_at"],
      "PRIMARY KEY (…), CONSTRAINT … UNIQUE and FOREIGN KEY are constraints",
    );
    // The comma inside NUMERIC(12, 2) is not an element separator.
    assert.equal(po.find((c) => c.name === "amount")!.dataType, "NUMERIC(12, 2)");
    // The table-level PRIMARY KEY (id) still marks its column.
    assert.equal(po.find((c) => c.name === "id")!.primaryKey, true);
  });

  test("ALTER TABLE … ADD COLUMN adds a column to the existing table", () => {
    const added = f.columns.filter((c) => c.statement === "alter_add");
    assert.deepEqual(added.map((c) => `${c.table}.${c.name}`), ["purchase_orders.approved_by"]);
    assert.equal(added[0]!.dataType, "INTEGER");
    assert.equal(added[0]!.line, lineOf(FIXTURE_SQL, "ADD COLUMN approved_by"));
  });

  test("every CREATE TABLE with a column list is a table; CREATE TABLE … AS is a gap", () => {
    assert.deepEqual(f.tables.map((t) => t.name), ["users", "purchase_orders", "mail_events"]);
    assert.equal(f.gaps.length, 1);
    const gap = f.gaps[0]!;
    assert.equal(gap.table, "po_archive", "the table exists; only its columns are unknown");
    assert.equal(gap.line, lineOf(FIXTURE_SQL, "CREATE TABLE po_archive AS"));
    assert.match(gap.statement, /^CREATE TABLE po_archive AS SELECT/);
    assert.match(gap.reason, /query/);
  });

  test("statements that cannot change a column are skipped and counted, not gaps", () => {
    // CREATE EXTENSION and CREATE INDEX. Counted so the reader can see them.
    assert.equal(f.skipped, 2);
  });

  test("comments, strings, dollar quotes and quoted identifiers do not confuse the splitter", () => {
    const g = extractDdl("x.sql", [
      "/* block; comment */ CREATE TABLE \"Accounts\" (",   // 1
      "  \"Owner Id\" int NOT NULL, -- trailing; comment",  // 2
      "  note text DEFAULT 'a;b(c'",                        // 3
      ");",                                                 // 4
      "CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN; END; $$ LANGUAGE plpgsql;", // 5
      "CREATE VIEW v AS SELECT 1;",                         // 6
    ].join("\n"));
    assert.deepEqual(g.tables.map((t) => `${t.name}@${t.line}`), ["accounts@1"]);
    assert.deepEqual(g.columns.map((c) => `${c.name}:${c.dataType}@${c.line}`),
      ["owner id:int@2", "note:text@3"]);
    assert.equal(g.skipped, 1, "the function body is one statement, and skipped");
    assert.deepEqual(g.gaps.map((x) => `${x.table}@${x.line}`), ["null@6"],
      "an unrecognised statement is a file-level gap");
  });

  test("CRLF line endings (the corpus is on Windows) give the same columns and lines", () => {
    const crlf = extractDdl(MIGRATION, FIXTURE_SQL.replace(/\n/g, "\r\n"));
    const flat = (x: typeof f) => x.columns.map((c) => `${c.table}.${c.name}:${c.dataType}@${c.line}`);
    assert.deepEqual(flat(crlf), flat(f));
    assert.deepEqual(crlf.gaps.map((g) => g.line), f.gaps.map((g) => g.line));
  });

  test("an ALTER TABLE action other than ADD COLUMN is a gap on that table", () => {
    const g = extractDdl("x.sql",
      "ALTER TABLE users ADD COLUMN age int, DROP COLUMN legacy;\n" +
      "ALTER TABLE users ADD CONSTRAINT uq UNIQUE (email);");
    assert.deepEqual(g.columns.map((c) => c.name), ["age"]);
    assert.deepEqual(g.gaps.map((x) => x.table), ["users"]);
    assert.match(g.gaps[0]!.reason, /DROP COLUMN/);
  });

  test("only .sql files are DDL files", () => {
    assert.equal(isDdlFile("migrations/001_init.sql"), true);
    assert.equal(isDdlFile("migrations/001_INIT.SQL"), true);
    assert.equal(isDdlFile("server.js"), false);
  });
});

// ---------------------------------------------------------------------------
// Through the index pipeline: store, join, gaps, incremental
// ---------------------------------------------------------------------------

/** A JS file whose SQL literals name two of the migration's tables. */
const SERVER_JS = [
  "const { Pool } = require('pg');",
  "const pool = new Pool();",
  "async function findUser(id) {",
  "  return pool.query('SELECT id, email FROM users WHERE id = $1', [id]);",
  "}",
  "async function recordMail(t) {",
  "  return pool.query('INSERT INTO mail_events (event_type) VALUES ($1)', [t]);",
  "}",
  "module.exports = { findUser, recordMail };",
].join("\n");

let dir: string;
let repoRoot: string;
let store: FactStore;
let first: IndexReport;
let repo: RepoConfig;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "code-intel-ddl-"));
  repoRoot = join(dir, "engine");
  mkdirSync(join(repoRoot, "migrations"), { recursive: true });
  copyFileSync(FIXTURE, join(repoRoot, MIGRATION));
  writeFileSync(join(repoRoot, "server.js"), SERVER_JS);
  repo = {
    name: "ddl-engine", rootPath: repoRoot, serviceName: "ddl-engine", lang: "js",
    framework: "none", entrypoint: "server.js",
    // The corpus declaration for 41-kri-engine, verbatim.
    include: ["server.js", "migrations/**"], exclude: [],
    baseUrlEnvVars: [], port: null, tsconfig: null, pythonBin: null,
  };
  store = new FactStore(join(dir, "graph.db"));
  first = await indexRepo({ store, repo, artifactDir: join(dir, ".codeintel") });
});

after(() => {
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

function columnsOf(table: string): Array<{ name: string; statement: string }> {
  return store.raw().prepare(
    `SELECT c.name, c.statement
       FROM datastore_columns c JOIN nodes n ON n.id = c.datastore_node_id
      WHERE n.kind = 'datastore' AND n.key = ?
      ORDER BY c.statement_line, c.position`,
  ).all(datastoreKey({ engine: "postgres", table })) as Array<{ name: string; statement: string }>;
}

function ddlGaps(): Array<{ path: string; line: number; target_hint: string }> {
  return store.raw().prepare(
    `SELECT f.path, u.line, u.target_hint FROM unresolved_calls u
       JOIN files f ON f.id = u.file_id
      WHERE u.kind = 'datastore' ORDER BY u.line`,
  ).all() as Array<{ path: string; line: number; target_hint: string }>;
}

describe("DDL through `index` (CTX-S9)", () => {
  test("the migration is in the file set and its columns are stored", () => {
    assert.ok(first.change.changed.includes(MIGRATION), "the .sql file is hashed and tracked");
    assert.deepEqual(columnsOf("users").map((c) => c.name), USERS_COLUMNS);
    assert.deepEqual(first.ddl, { files: 1, tables: 3, columns: 17, added: 1, gaps: 1, skipped: 2 });
  });

  test("a migration table and a literal's table are ONE datastore node", () => {
    // The key the SQL-literal extractor produces for `users` ...
    const literal = readSql("SELECT id, email FROM users WHERE id = $1");
    const literalKey = datastoreKey({ engine: "postgres", table: literal!.table });
    // ... is the key the DDL columns hang off, and there is one such node.
    const nodes = store.raw().prepare(
      "SELECT id, key FROM nodes WHERE kind = 'datastore' AND key LIKE '%/users'",
    ).all() as Array<{ id: number; key: string }>;
    assert.deepEqual(nodes.map((n) => n.key), [literalKey]);

    const read = store.raw().prepare(
      `SELECT e.dst_node_id FROM edges e WHERE e.type = 'READS' AND e.evidence_kind = 'treesitter'`,
    ).get() as { dst_node_id: number };
    const owner = store.raw().prepare(
      "SELECT DISTINCT datastore_node_id FROM datastore_columns WHERE name = 'password_hash'",
    ).get() as { datastore_node_id: number };
    assert.equal(read.dst_node_id, nodes[0]!.id, "the literal READS the node");
    assert.equal(owner.datastore_node_id, nodes[0]!.id, "the columns hang off the same node");
  });

  test("the unparseable statement is a stored gap with file:line (R11)", () => {
    assert.deepEqual(
      ddlGaps().map((g) => `${g.path}:${g.line}`),
      [`${MIGRATION}:${lineOf(FIXTURE_SQL, "CREATE TABLE po_archive AS")}`],
    );
  });

  test("the index report prints the table and column counts", () => {
    const text = renderIndexReport([first]);
    assert.match(text, /ddl\s+: 3 tables, 17 columns \(\+1 added by ALTER TABLE\), 1 gap/);
  });

  test("`tables` lists each table with columns, source and gaps, and states OPEN-9", () => {
    const report = listTables(store);
    const users = report.tables.find((t) => t.key === "postgres://?/users")!;
    assert.deepEqual(users.columns.map((c) => c.name), USERS_COLUMNS);
    assert.deepEqual(users.declaredIn, [{
      repo: "ddl-engine", file: MIGRATION,
      line: lineOf(FIXTURE_SQL, "CREATE TABLE IF NOT EXISTS users"),
    }]);
    assert.equal(users.reads, 1);
    const po = report.tables.find((t) => t.key === "postgres://?/purchase_orders")!;
    assert.equal(po.createColumns, 6);
    assert.equal(po.addedColumns, 1);
    const archive = report.tables.find((t) => t.key === "postgres://?/po_archive")!;
    assert.equal(archive.columns.length, 0);
    assert.equal(archive.gaps.length, 1);

    const text = renderTables(report);
    assert.match(text, /postgres:\/\/\?\/users\s+7 columns/);
    assert.match(text, /OPEN-9/);
    assert.match(text, /no database identity/);
  });

  test("`tables --json` runs from the CLI against the store", () => {
    const run = spawnSync(
      process.execPath, ["src/cli.ts", "tables", "--json", "--db", store.path],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    const parsed = JSON.parse(run.stdout) as { tables: Array<{ key: string }>; limit: string };
    assert.ok(parsed.tables.some((t) => t.key === "postgres://?/mail_events"));
    assert.match(parsed.limit, /OPEN-9/);
  });

  test("an unchanged migration is not re-extracted, and nothing moves", async () => {
    const before = store.countRows("datastore_columns");
    const again = await indexRepo({ store, repo, artifactDir: join(dir, ".codeintel") });
    assert.equal(again.skipped, true);
    assert.equal(store.countRows("datastore_columns"), before);
  });

  test("re-indexing a changed migration replaces exactly its rows (R28)", async () => {
    // users gains a column; the CREATE TABLE … AS is removed.
    const edited = FIXTURE_SQL
      .replace("    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP\n",
        "    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,\n" +
        "    last_login_at TIMESTAMP\n")
      .replace(/CREATE TABLE po_archive AS[^\n]*\n/, "");
    assert.notEqual(edited, FIXTURE_SQL, "the edit applied");
    writeFileSync(join(repoRoot, MIGRATION), edited);

    const readsBefore = store.raw().prepare(
      "SELECT COUNT(*) AS n FROM edges WHERE type IN ('READS', 'WRITES')",
    ).get() as { n: number };

    const report = await indexRepo({ store, repo, artifactDir: join(dir, ".codeintel") });
    assert.deepEqual(report.change.changed, [MIGRATION], "only the migration changed");
    assert.equal(report.purged.columns, 18, "every row the old file claimed");
    assert.deepEqual(columnsOf("users").map((c) => c.name), [...USERS_COLUMNS, "last_login_at"]);
    assert.equal(columnsOf("purchase_orders").length, 7, "no duplicates after re-index");
    assert.deepEqual(ddlGaps(), [], "the removed statement's gap went with it");

    // server.js did not change: its literal edges into these nodes survive.
    const readsAfter = store.raw().prepare(
      "SELECT COUNT(*) AS n FROM edges WHERE type IN ('READS', 'WRITES')",
    ).get() as { n: number };
    assert.equal(readsAfter.n, readsBefore.n);
    // Nodes are never deleted (R28): po_archive stays as an orphan node.
    assert.ok(store.findNode("datastore", "postgres://?/po_archive") !== undefined);
  });
});
