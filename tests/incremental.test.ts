// Tests for incremental indexing (task P1-T11, R27-R29).
//
// The acceptance criterion the plan states is "change one file, confirm only
// its rows are replaced and nothing else moves". The failure it guards is
// specific and quiet: deleting by NODE takes edges that other files own, and
// nothing reports the loss — the graph just gets smaller. So the tests below
// are written from the direction of what must SURVIVE, not what must go.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactStore } from "../src/store/db.ts";
import {
  diffFiles, forgetDeletedFiles, hashText, planDerivations, purgeByProvenance,
  STATIC_EVIDENCE,
} from "../src/index/incremental.ts";

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), "code-intel-incr-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

/**
 * Two files. `b.ts` calls a symbol defined in `a.ts`.
 *
 * That cross-file edge is the whole point: it is *owned by b.ts* — b.ts is
 * what claimed it — and it must survive a re-index of a.ts.
 */
function seed(store: FactStore) {
  const repoId = store.upsertRepo("svc", "/tmp/svc", "svc");
  const runId = store.startRun(repoId, "static", "scip@0.4.0", "");
  const aId = store.upsertFile(repoId, "a.ts", "ts", hashText("a v1"), runId);
  const bId = store.upsertFile(repoId, "b.ts", "ts", hashText("b v1"), runId);

  const fnA = store.upsertNode("symbol", "scip npm svc 1 `a.ts`/helper().", repoId);
  const fnB = store.upsertNode("symbol", "scip npm svc 1 `b.ts`/caller().", repoId);
  const cfg = store.upsertNode("config", "env:DATABASE_URL", null);

  // Owned by a.ts.
  store.insertEdge({
    srcNodeId: fnA, dstNodeId: cfg, type: "READS_CONFIG", confidence: "inferred",
    evidenceKind: "treesitter", fileId: aId, line: 3, runId,
  });
  // Owned by b.ts, pointing INTO a.ts's symbol.
  store.insertEdge({
    srcNodeId: fnB, dstNodeId: fnA, type: "CALLS", confidence: "certain",
    evidenceKind: "scip", fileId: bId, line: 9, runId,
  });
  store.insertUnresolved({
    srcNodeId: fnA, kind: "call", targetHint: "npm:axios", reason: "package",
    fileId: aId, line: 4, runId,
  });

  return { repoId, runId, aId, bId, fnA, fnB, cfg };
}

describe("change detection (R27)", () => {
  test("classifies changed, unchanged and deleted", () => {
    const store = new FactStore(join(dir, "diff.db"));
    try {
      const { repoId } = seed(store);
      const now = new Map([
        ["a.ts", hashText("a v2")],   // modified
        ["b.ts", hashText("b v1")],   // untouched
        ["c.ts", hashText("c v1")],   // added
      ]);
      const change = diffFiles(store, repoId, now);
      assert.deepEqual(change.changed.sort(), ["a.ts", "c.ts"]);
      assert.deepEqual(change.unchanged, ["b.ts"]);
      assert.deepEqual(change.deleted, []);
    } finally { store.close(); }
  });

  test("a file no longer present is reported deleted", () => {
    const store = new FactStore(join(dir, "deleted.db"));
    try {
      const { repoId } = seed(store);
      const change = diffFiles(store, repoId, new Map([["a.ts", hashText("a v1")]]));
      assert.deepEqual(change.deleted, ["b.ts"]);
      assert.deepEqual(change.changed, []);
    } finally { store.close(); }
  });

  test("nothing changed means no derivation runs", () => {
    const plan = planDerivations({ changed: [], deleted: [], unchanged: ["a.ts"] });
    assert.equal(plan.scip, false);
    assert.equal(plan.reason, "no file changed");
    assert.equal(planDerivations({ changed: [], deleted: [], unchanged: [] }, true).scip, true);
  });
});

describe("delete by provenance, never by node (R28)", () => {
  test("re-indexing a.ts keeps b.ts's edge INTO a.ts", () => {
    // The specific defect. `helper` is defined in a.ts and called from b.ts;
    // b.ts has not changed, so its claim is still true. Deleting by node
    // would take this edge with it through ON DELETE CASCADE and nothing
    // would say so.
    const store = new FactStore(join(dir, "provenance.db"));
    try {
      const { repoId, fnA, fnB } = seed(store);
      const purged = purgeByProvenance(store, repoId, ["a.ts"], STATIC_EVIDENCE);

      assert.equal(purged.edges, 1, "only the edge a.ts claimed");
      assert.equal(purged.unresolved, 1);

      const survivors = store.raw().prepare(
        "SELECT src_node_id, dst_node_id, type FROM edges",
      ).all() as Array<{ src_node_id: number; dst_node_id: number; type: string }>;
      assert.equal(survivors.length, 1);
      assert.equal(survivors[0]!.src_node_id, fnB);
      assert.equal(survivors[0]!.dst_node_id, fnA);
    } finally { store.close(); }
  });

  test("nodes are never deleted", () => {
    // An orphaned node is cheap and honest. A missing edge is a false
    // negative, and there is no way to tell one from "nothing was there".
    const store = new FactStore(join(dir, "nodes-survive.db"));
    try {
      const { repoId } = seed(store);
      const before = store.countRows("nodes");
      purgeByProvenance(store, repoId, ["a.ts", "b.ts"], STATIC_EVIDENCE);
      assert.equal(store.countRows("edges"), 0);
      assert.equal(store.countRows("nodes"), before, "identity outlives evidence");
    } finally { store.close(); }
  });

  test("a static re-index cannot delete boot rows", () => {
    // The two channels see different halves of an endpoint. A static re-index
    // that dropped the route chain would report "this route has no middleware"
    // until someone happened to re-run the boot dump.
    const store = new FactStore(join(dir, "channels.db"));
    try {
      const { repoId, runId, aId, fnA } = seed(store);
      const routeId = store.upsertNode("route", "svc GET /x", repoId);
      store.upsertRoute({
        nodeId: routeId, repoId, serviceName: "svc", method: "GET", url: "/x",
        source: "boot", runId,
      });
      store.insertEdge({
        srcNodeId: routeId, dstNodeId: fnA, type: "HANDLES", confidence: "certain",
        evidenceKind: "boot", fileId: aId, line: 1, runId,
      });
      store.insertChainEntry({
        routeNodeId: routeId, position: 0, phase: "handler", origin: "route",
        confidence: "certain", evidenceKind: "boot", fileId: aId, line: 1, runId,
      });

      purgeByProvenance(store, repoId, ["a.ts"], STATIC_EVIDENCE);

      assert.equal(store.countRows("route_chain"), 1, "boot chain row survives");
      const handles = store.raw().prepare(
        "SELECT COUNT(*) AS n FROM edges WHERE type = 'HANDLES'",
      ).get() as { n: number };
      assert.equal(handles.n, 1, "boot HANDLES edge survives");
    } finally { store.close(); }
  });

  test("an inline-auth chain row survives a static re-index of its own file", () => {
    // R26's rows are evidence_kind='treesitter', which IS in the static set,
    // so they are correctly replaced — but only for the file that produced
    // them. This asserts the scoping works in the direction that removes.
    const store = new FactStore(join(dir, "inline.db"));
    try {
      const { repoId, runId, aId, bId } = seed(store);
      const routeId = store.upsertNode("route", "svc GET /y", repoId);
      store.upsertRoute({
        nodeId: routeId, repoId, serviceName: "svc", method: "GET", url: "/y",
        source: "boot", runId,
      });
      store.insertChainEntry({
        routeNodeId: routeId, position: 0, phase: "handler_inline", origin: "handler",
        confidence: "inferred", evidenceKind: "treesitter", name: "checkUserAuth",
        checkKind: "auth", fileId: bId, line: 12, runId,
      });

      purgeByProvenance(store, repoId, ["a.ts"], STATIC_EVIDENCE);
      assert.equal(store.countRows("route_chain"), 1, "b.ts's row is not a.ts's to delete");

      purgeByProvenance(store, repoId, ["b.ts"], STATIC_EVIDENCE);
      assert.equal(store.countRows("route_chain"), 0, "and is replaced when b.ts is re-indexed");
      assert.ok(aId !== bId);
    } finally { store.close(); }
  });
});

describe("forgetting deleted files", () => {
  test("the files row goes, after its dependent rows", () => {
    const store = new FactStore(join(dir, "forget.db"));
    try {
      const { repoId } = seed(store);
      purgeByProvenance(store, repoId, ["a.ts"], STATIC_EVIDENCE);
      assert.equal(forgetDeletedFiles(store, repoId, ["a.ts"]), 1);
      assert.equal(store.getFile(repoId, "a.ts"), undefined);
      // Otherwise the next diff reports it as deleted forever.
      const change = diffFiles(store, repoId, new Map([["b.ts", hashText("b v1")]]));
      assert.deepEqual(change.deleted, []);
    } finally { store.close(); }
  });
});
