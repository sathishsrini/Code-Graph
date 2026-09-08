// Tests for the migration runner and the Phase 1 tables (task P1-T1).
//
// The assertions worth having here are not "the DDL parses" — SQLite proves
// that by executing it. They are the properties that make a migration runner
// different from re-running a schema file: applied once, ordered, recorded,
// and honest about what is NOT present yet (R72).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FactStore, SCHEMA_VERSION } from "../src/store/db.ts";
import { migrate, loadMigrations, latestVersion } from "../src/store/migrate.ts";

let dir: string;

before(() => { dir = mkdtempSync(join(tmpdir(), "code-intel-migrate-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

function tableNames(store: FactStore): Set<string> {
  const rows = store.raw().prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

describe("migration runner", () => {
  test("migrations are numbered, ordered and non-empty", () => {
    const all = loadMigrations();
    assert.ok(all.length >= 2, "at least the phase 0 core and the phase 1 tables");
    const versions = all.map((m) => m.version);
    assert.deepEqual(versions, [...versions].sort(), "lexicographic order is numeric order");
    assert.equal(new Set(versions).size, versions.length, "no duplicate versions");
    assert.equal(latestVersion(), versions[versions.length - 1]);
  });

  test("no migration sets journal_mode", () => {
    // It is a no-op inside the transaction a migration runs in — a silent
    // failure, which is the kind this project exists to stop shipping.
    for (const m of loadMigrations()) {
      assert.ok(!/PRAGMA\s+journal_mode/i.test(m.sql), `${m.version} must not set journal_mode`);
    }
  });

  test("a fresh database applies every migration exactly once", () => {
    const path = join(dir, "fresh.db");
    const first = new FactStore(path);
    try {
      assert.equal(first.migrations.applied.length, loadMigrations().length);
      assert.equal(first.migrations.alreadyApplied.length, 0);
    } finally { first.close(); }

    const second = new FactStore(path);
    try {
      assert.deepEqual(second.migrations.applied, [], "second open applies nothing");
      assert.equal(second.migrations.alreadyApplied.length, loadMigrations().length);
      assert.equal(second.verifyIntegrity().ok, true);
    } finally { second.close(); }
  });

  test("SCHEMA_VERSION is the last recorded version, not a hand-typed string", () => {
    const store = new FactStore(join(dir, "version.db"));
    try {
      const rows = store.raw().prepare(
        "SELECT version FROM schema_version ORDER BY version",
      ).all() as Array<{ version: string }>;
      assert.equal(rows[rows.length - 1]!.version, SCHEMA_VERSION);
    } finally { store.close(); }
  });

  test("a failing migration rolls back its own file and leaves earlier ones applied", () => {
    const bad = join(dir, "badmigrations");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "001_ok.sql"), "CREATE TABLE a (id INTEGER PRIMARY KEY);");
    writeFileSync(join(bad, "002_broken.sql"),
      "CREATE TABLE b (id INTEGER PRIMARY KEY);\nTHIS IS NOT SQL;");

    const db = new DatabaseSync(join(dir, "partial.db"));
    try {
      assert.throws(() => migrate(db, bad), /migration 002_broken failed/);
      const names = (db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      ).all() as Array<{ name: string }>).map((r) => r.name);
      assert.ok(names.includes("a"), "001 stayed applied");
      assert.ok(!names.includes("b"), "002 rolled back whole");
      const done = db.prepare("SELECT version FROM schema_version").all() as
        Array<{ version: string }>;
      assert.deepEqual(done.map((r) => r.version), ["001_ok"]);
    } finally { db.close(); }
  });
});

describe("phase 1 schema", () => {
  test("routes, route_chain and unresolved_calls exist", () => {
    const store = new FactStore(join(dir, "p1.db"));
    try {
      const names = tableNames(store);
      for (const t of ["routes", "route_chain", "unresolved_calls"]) {
        assert.ok(names.has(t), `${t} present`);
      }
    } finally { store.close(); }
  });

  test("a table ships only once it has a producer (R72)", () => {
    // `spans` arrived with the OTLP receiver in P2-T8 and is present now;
    // `summaries` waits for the LLM layer (P3-T2). A table that is
    // structurally guaranteed to be empty is what 470 lines of dead DDL looked
    // like the last two times, and a query joining one answers "no evidence"
    // when the truth is "no producer".
    //
    // This assertion moves as producers land. It failing because a table
    // appeared is the signal working, not the test being stale — check the
    // producer shipped in the same commit.
    const store = new FactStore(join(dir, "absent.db"));
    try {
      const names = tableNames(store);
      assert.ok(names.has("spans"), "spans has a producer: src/runtime/otlp.ts");
      assert.ok(!names.has("summaries"), "summaries has no producer until P3-T2");
    } finally { store.close(); }
  });

  test("route detail is keyed by node id — no parallel id space (R12)", () => {
    const store = new FactStore(join(dir, "routes.db"));
    try {
      const repoId = store.upsertRepo("svc", "/tmp/svc", "svc");
      const runId = store.startRun(repoId, "boot", "fastify@4", "");
      const nodeId = store.upsertNode("route", "svc POST /api/v1/po", repoId);
      store.upsertRoute({
        nodeId, repoId, serviceName: "svc", method: "post", url: "/api/v1/po",
        source: "boot", runId,
      });

      const row = store.raw().prepare(
        "SELECT node_id, method FROM routes WHERE node_id = ?",
      ).get(nodeId) as { node_id: number; method: string };
      assert.equal(row.node_id, nodeId, "primary key IS the node id");
      assert.equal(row.method, "POST", "method is normalised on write");

      // Idempotent: a second boot dump updates rather than duplicating.
      store.upsertRoute({
        nodeId, repoId, serviceName: "svc", method: "POST", url: "/api/v1/po",
        source: "boot", runId, hasSchema: true,
      });
      assert.equal(store.countRows("routes"), 1);
    } finally { store.close(); }
  });

  test("re-running one channel leaves the other channel's chain rows alone", () => {
    // The property R26 depends on: the boot channel and the inline-auth
    // channel answer the same question from different evidence, and a re-run
    // of one must not delete the other's findings.
    const store = new FactStore(join(dir, "chain.db"));
    try {
      const repoId = store.upsertRepo("svc", "/tmp/svc", "svc");
      const runId = store.startRun(repoId, "boot", "fastify@4", "");
      const routeId = store.upsertNode("route", "svc POST /p", repoId);
      store.upsertRoute({
        nodeId: routeId, repoId, serviceName: "svc", method: "POST", url: "/p",
        source: "boot", runId,
      });

      store.insertChainEntry({
        routeNodeId: routeId, position: 0, phase: "onRequest", origin: "scope",
        confidence: "certain", evidenceKind: "boot", key: "server.js:36:29", runId,
      });
      store.insertChainEntry({
        routeNodeId: routeId, position: 0, phase: "handler_inline", origin: "handler",
        confidence: "inferred", evidenceKind: "treesitter", name: "checkUserAuth",
        checkKind: "auth", runId,
      });
      assert.equal(store.countRows("route_chain"), 2);

      const removed = store.deleteChain(routeId, ["boot"]);
      assert.equal(removed, 1);
      // node:sqlite returns null-prototype rows, so compare projected values.
      const left = (store.raw().prepare(
        "SELECT phase, check_kind FROM route_chain",
      ).all() as Array<{ phase: string; check_kind: string | null }>)
        .map((r) => `${r.phase}/${r.check_kind}`);
      assert.deepEqual(left, ["handler_inline/auth"]);
    } finally { store.close(); }
  });

  test("the same chain position re-inserts as an update, not a duplicate", () => {
    const store = new FactStore(join(dir, "chain-idem.db"));
    try {
      const repoId = store.upsertRepo("svc", "/tmp/svc", "svc");
      const runId = store.startRun(repoId, "boot", "fastify@4", "");
      const routeId = store.upsertNode("route", "svc GET /q", repoId);
      store.upsertRoute({
        nodeId: routeId, repoId, serviceName: "svc", method: "GET", url: "/q",
        source: "boot", runId,
      });
      for (const name of ["first", "second"]) {
        store.insertChainEntry({
          routeNodeId: routeId, position: 0, phase: "handler", origin: "route",
          confidence: "certain", evidenceKind: "boot", name, runId,
        });
      }
      assert.equal(store.countRows("route_chain"), 1);
      const row = store.raw().prepare("SELECT name FROM route_chain").get() as { name: string };
      assert.equal(row.name, "second", "last boot wins (R24)");
    } finally { store.close(); }
  });

  test("unresolved_calls deduplicates across re-runs despite NULL columns", () => {
    // SQLite treats two NULLs as distinct, so a plain UNIQUE would let every
    // re-index insert a fresh copy. Same defect, same fix, as edges (D8).
    const store = new FactStore(join(dir, "unresolved.db"));
    try {
      const repoId = store.upsertRepo("svc", "/tmp/svc", "svc");
      const runId = store.startRun(repoId, "static", "scip@0.4.0", "");
      const src = store.upsertNode("symbol", "scip npm svc 1 server.js/forward().", repoId);

      for (let i = 0; i < 3; i += 1) {
        store.insertUnresolved({
          srcNodeId: src, kind: "call",
          targetHint: "scip-typescript npm axios 1.7.2 index.d.ts/",
          reason: "callee resolved to a package, not to a function", runId,
        });
      }
      assert.equal(store.countRows("unresolved_calls"), 1);
    } finally { store.close(); }
  });
});
