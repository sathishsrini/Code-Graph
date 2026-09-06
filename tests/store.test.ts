// Tests for the SQLite fact store (task P0-T5).
//
// These assert the invariants that the v1/v2 attempts got wrong — see
// .claude/COMMON_MISTAKES.md. They are cheap and they are the difference
// between "the schema looks right" and "the schema behaves right".

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactStore } from "../src/store/db.ts";

let dir: string;

function freshStore(name = "graph.db"): FactStore {
  return new FactStore(join(dir, name));
}

/** A store seeded with one repo, one run and one file. */
function seeded(store: FactStore): { repoId: number; runId: number; fileId: number } {
  const repoId = store.upsertRepo("svc", "/tmp/svc", "svc");
  const runId = store.startRun(repoId, "static", "test@0", "abc123");
  const fileId = store.upsertFile(repoId, "src/a.ts", "ts", "hash-a", runId);
  return { repoId, runId, fileId };
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "code-intel-test-"));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("bootstrap", () => {
  test("creates a valid database with all six tables", () => {
    const store = freshStore("bootstrap.db");
    try {
      const report = store.verifyIntegrity();
      assert.equal(report.ok, true);
      assert.equal(report.foreignKeyViolations, 0);
      assert.equal(report.integrityCheck, "ok");
      for (const t of ["repos", "runs", "files", "nodes", "symbols", "edges"]) {
        assert.equal(store.countRows(t), 0, `${t} exists and is empty`);
      }
    } finally {
      store.close();
    }
  });

  test("re-opening an existing database is idempotent", () => {
    const path = join(dir, "idempotent.db");
    const first = new FactStore(path);
    const repoId = first.upsertRepo("svc", "/tmp/svc", null);
    first.close();

    const second = new FactStore(path);
    try {
      assert.equal(second.countRows("repos"), 1, "no duplicate schema application");
      assert.equal(second.upsertRepo("svc", "/tmp/svc", null), repoId, "same repo id");
      assert.equal(second.verifyIntegrity().ok, true);
    } finally {
      second.close();
    }
  });

  test("reset deletes the database and its WAL sidecars", () => {
    const path = join(dir, "reset.db");
    const first = new FactStore(path);
    first.upsertRepo("gone", "/tmp/gone", null);
    first.close();
    assert.ok(existsSync(path));

    const second = FactStore.reset(path);
    try {
      assert.equal(second.countRows("repos"), 0, "reset produced an empty database");
    } finally {
      second.close();
    }
  });

  test("rejects an unsafe table name in countRows", () => {
    const store = freshStore("unsafe.db");
    try {
      assert.throws(() => store.countRows("edges; DROP TABLE nodes"), /unsafe table name/);
    } finally {
      store.close();
    }
  });
});

describe("node identity (R4, R9)", () => {
  test("upsertNode is idempotent on (kind, key)", () => {
    const store = freshStore("nodes.db");
    try {
      const { repoId } = seeded(store);
      const scipSymbol = "scip-typescript npm svc 1.0.0 `src/a.ts`/doThing().";
      const a = store.upsertNode("symbol", scipSymbol, repoId);
      const b = store.upsertNode("symbol", scipSymbol, repoId);
      assert.equal(a, b, "same SCIP symbol string yields the same node id");
      assert.equal(store.countRows("nodes"), 1);
    } finally {
      store.close();
    }
  });

  test("foreign keys are enforced — a dangling repo_id is rejected", () => {
    // PRAGMA foreign_keys defaults to OFF in SQLite. The schema turns it on,
    // and this asserts it actually took effect: without it, orphan rows
    // accumulate silently and integrity checks stay green.
    const store = freshStore("fk.db");
    try {
      assert.throws(
        () => store.upsertNode("symbol", "orphan", 9999),
        /FOREIGN KEY constraint failed/,
      );
    } finally {
      store.close();
    }
  });

  test("the same key under a different kind is a different node", () => {
    const store = freshStore("kinds.db");
    try {
      const route = store.upsertNode("route", "svc|POST|/x", null);
      const external = store.upsertNode("external", "svc|POST|/x", null);
      assert.notEqual(route, external);
      assert.equal(store.countRows("nodes"), 2);
    } finally {
      store.close();
    }
  });

  test("R9: an edge may span two repos without a mapping table", () => {
    const store = freshStore("crossrepo.db");
    try {
      const repoA = store.upsertRepo("a", "/tmp/a", "a");
      const repoB = store.upsertRepo("b", "/tmp/b", "b");
      const runId = store.startRun(repoA, "static", "test@0", "sha");

      const caller = store.upsertNode("symbol", "scip a `x.ts`/call().", repoA);
      const remote = store.upsertNode("route", "b|POST|/api/v1/thing", repoB);

      store.insertEdge({
        srcNodeId: caller, dstNodeId: remote, type: "REQUESTS",
        confidence: "inferred", evidenceKind: "treesitter", runId,
      });

      assert.equal(store.countRows("edges"), 1, "cross-repo edge is an ordinary row");
    } finally {
      store.close();
    }
  });
});

describe("edge identity", () => {
  test("duplicate edges with identical provenance collapse to one row", () => {
    const store = freshStore("dupe.db");
    try {
      const { runId, fileId } = seeded(store);
      const a = store.upsertNode("symbol", "sym-a", 1);
      const b = store.upsertNode("symbol", "sym-b", 1);

      const edge = {
        srcNodeId: a, dstNodeId: b, type: "CALLS" as const,
        confidence: "certain" as const, evidenceKind: "scip" as const,
        runId, fileId, line: 12,
      };
      store.insertEdge(edge);
      store.insertEdge(edge);
      store.insertEdge(edge);

      assert.equal(store.countRows("edges"), 1);
    } finally {
      store.close();
    }
  });

  test("NULL file_id and line still deduplicate — the boot/otel case", () => {
    // This is the deviation from plan §H. A plain UNIQUE constraint would NOT
    // collapse these, because SQLite treats two NULLs as distinct, so every
    // boot dump would insert a fresh duplicate.
    const store = freshStore("nulldupe.db");
    try {
      const { runId } = seeded(store);
      const handler = store.upsertNode("symbol", "handler", 1);
      const route = store.upsertNode("route", "svc|POST|/x", 1);

      const bootEdge = {
        srcNodeId: handler, dstNodeId: route, type: "HANDLES" as const,
        confidence: "certain" as const, evidenceKind: "boot" as const,
        runId, fileId: null, line: null,
      };
      store.insertEdge(bootEdge);
      store.insertEdge(bootEdge);

      assert.equal(store.countRows("edges"), 1, "NULL provenance must still deduplicate");
    } finally {
      store.close();
    }
  });

  test("the same edge from a different channel is kept separately", () => {
    // Runtime confirmation must not overwrite the static claim — it stands
    // alongside it as independent evidence (R56).
    const store = freshStore("channels.db");
    try {
      const { runId } = seeded(store);
      const a = store.upsertNode("symbol", "caller", 1);
      const b = store.upsertNode("route", "svc|POST|/x", 1);

      store.insertEdge({
        srcNodeId: a, dstNodeId: b, type: "REQUESTS",
        confidence: "inferred", evidenceKind: "treesitter", runId, fileId: null, line: null,
      });
      store.insertEdge({
        srcNodeId: a, dstNodeId: b, type: "REQUESTS",
        confidence: "observed", evidenceKind: "otel", runId, fileId: null, line: null,
      });

      assert.equal(store.countRows("edges"), 2, "distinct evidence_kind = distinct rows");
    } finally {
      store.close();
    }
  });

  test("CHECK constraints reject an invalid confidence value", () => {
    const store = freshStore("check.db");
    try {
      const { runId } = seeded(store);
      const a = store.upsertNode("symbol", "a", 1);
      const b = store.upsertNode("symbol", "b", 1);
      assert.throws(
        () => store.raw().prepare(
          `INSERT INTO edges (src_node_id, dst_node_id, type, confidence, evidence_kind, run_id)
           VALUES (?, ?, 'CALLS', 'exact', 'scip', ?)`,
        ).run(a, b, runId),
        /CHECK constraint failed/,
        "'exact' is the v2 lossy value and must be rejected",
      );
    } finally {
      store.close();
    }
  });
});

describe("incremental update (R28)", () => {
  test("delete by provenance removes the file's edges but keeps its nodes", () => {
    const store = freshStore("provenance.db");
    try {
      const { repoId, runId, fileId } = seeded(store);
      const otherFile = store.upsertFile(repoId, "src/b.ts", "ts", "hash-b", runId);

      const a = store.upsertNode("symbol", "a", repoId);
      const b = store.upsertNode("symbol", "b", repoId);

      // an edge owned by a.ts, and an edge owned by b.ts pointing INTO a
      store.insertEdge({
        srcNodeId: a, dstNodeId: b, type: "CALLS", confidence: "certain",
        evidenceKind: "scip", runId, fileId, line: 1,
      });
      store.insertEdge({
        srcNodeId: b, dstNodeId: a, type: "CALLS", confidence: "certain",
        evidenceKind: "scip", runId, fileId: otherFile, line: 2,
      });
      assert.equal(store.countRows("edges"), 2);

      const removed = store.deleteEdgesByProvenance(fileId, ["scip", "treesitter", "semgrep"]);

      assert.equal(removed, 1, "only a.ts's own edge is removed");
      assert.equal(store.countRows("edges"), 1, "the inbound edge from b.ts survives");
      assert.equal(store.countRows("nodes"), 2, "nodes are never deleted");
    } finally {
      store.close();
    }
  });

  test("changedFiles reports changed and deleted paths", () => {
    const store = freshStore("changed.db");
    try {
      const { repoId, runId } = seeded(store);
      store.upsertFile(repoId, "src/b.ts", "ts", "hash-b", runId);

      const now = new Map([
        ["src/a.ts", "hash-a"],       // unchanged
        ["src/b.ts", "hash-b-NEW"],   // changed
        ["src/c.ts", "hash-c"],       // added
      ]);
      const { changed, deleted } = store.changedFiles(repoId, now);

      assert.deepEqual(changed.sort(), ["src/b.ts", "src/c.ts"]);
      assert.deepEqual(deleted, []);
    } finally {
      store.close();
    }
  });

  test("changedFiles reports a file that disappeared", () => {
    const store = freshStore("deleted.db");
    try {
      const { repoId } = seeded(store);
      const { changed, deleted } = store.changedFiles(repoId, new Map());
      assert.deepEqual(changed, []);
      assert.deepEqual(deleted, ["src/a.ts"]);
    } finally {
      store.close();
    }
  });
});

describe("transactions", () => {
  test("a throw inside a transaction rolls everything back", () => {
    const store = freshStore("tx.db");
    try {
      seeded(store);
      const before = store.countRows("nodes");

      assert.throws(() => {
        store.transaction(() => {
          store.upsertNode("symbol", "will-be-rolled-back", 1);
          throw new Error("boom");
        });
      }, /boom/);

      assert.equal(store.countRows("nodes"), before, "rolled back");
    } finally {
      store.close();
    }
  });
});

describe("cross-file call detection", () => {
  test("crossFileCallCount is the guard against the v1 intra-file-only bug", () => {
    const store = freshStore("crossfile.db");
    try {
      const { repoId, runId, fileId } = seeded(store);
      const fileB = store.upsertFile(repoId, "src/b.ts", "ts", "hash-b", runId);

      const a = store.upsertNode("symbol", "a", repoId);
      const b = store.upsertNode("symbol", "b", repoId);
      store.upsertSymbol({ nodeId: a, fileId, displayName: "a" });
      store.upsertSymbol({ nodeId: b, fileId: fileB, displayName: "b" });

      assert.equal(store.crossFileCallCount(), 0, "none yet");

      store.insertEdge({
        srcNodeId: a, dstNodeId: b, type: "CALLS", confidence: "certain",
        evidenceKind: "scip", runId, fileId, line: 3,
      });

      assert.equal(store.crossFileCallCount(), 1, "a.ts -> b.ts is counted");
    } finally {
      store.close();
    }
  });
});
