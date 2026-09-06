// Tests for canonical node keys and the graph writer (task P1-T2).
//
// The assertion that matters is the first one in "global identity": a symbol
// from one repo and a route from another joined by a plain edge row, with no
// mapping table between them. Everything else here is guarding the ways that
// property gets lost.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactStore } from "../src/store/db.ts";
import { GraphWriter } from "../src/normalize/graph.ts";
import {
  routeKey, parseRouteKey, symbolKey, fileKey, packageKey, hostKey,
  datastoreKey, configKey, normalizeSlashes, ref,
} from "../src/normalize/keys.ts";

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), "code-intel-norm-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

describe("keys", () => {
  test("routeKey round-trips and normalises the method", () => {
    const k = routeKey("40-kri-router", "post", "/api/v1/po");
    assert.equal(k, "40-kri-router POST /api/v1/po");
    assert.deepEqual(parseRouteKey(k), {
      service: "40-kri-router", method: "POST", url: "/api/v1/po",
    });
  });

  test("routeKey survives urls containing spaces-free templates and colons", () => {
    const k = routeKey("svc", "GET", "/api/v1/po/:id/lines");
    assert.deepEqual(parseRouteKey(k)?.url, "/api/v1/po/:id/lines");
  });

  test("symbolKey is the verbatim SCIP string (R4)", () => {
    const s = "scip-typescript npm 40-kri-router 1.0.0 `server.js`/forward().";
    assert.equal(symbolKey(s), s, "not transformed, not normalised, not shortened");
  });

  test("symbolKey refuses the empty string", () => {
    // An empty key collides every unnamed symbol into one node, and the edges
    // between them look entirely real.
    assert.throws(() => symbolKey(""), /empty SCIP symbol/);
  });

  test("fileKey is repo-qualified and slash-normalised", () => {
    assert.equal(fileKey("40-kri-router", "src\\lib\\a.ts"), "40-kri-router/src/lib/a.ts");
    assert.equal(normalizeSlashes("./a/b.ts"), "a/b.ts");
    // Two repos can both contain server.js. They are different files.
    assert.notEqual(fileKey("40-kri-router", "server.js"), fileKey("41-kri-engine", "server.js"));
  });

  test("packageKey pins the version", () => {
    assert.equal(packageKey("npm", "axios", "1.7.2"), "npm:axios@1.7.2");
    assert.equal(packageKey("npm", "axios", null), "npm:axios");
    assert.notEqual(packageKey("npm", "axios", "1.7.2"), packageKey("npm", "axios", "1.8.0"));
  });

  test("hostKey strips scheme and trailing slashes", () => {
    assert.equal(hostKey("https://api.stripe.com/"), "http:api.stripe.com");
    assert.equal(hostKey("localhost:3003"), "http:localhost:3003");
  });

  test("two services reach the same datastore node when neither names the database", () => {
    // OPEN-9: 51-integration writes mail_events; 41-kri-engine's migration
    // creates it. No code indexer sees the coupling — they share a database,
    // not a call. It becomes a join only because both sides key identically.
    const writer = datastoreKey({ engine: "postgres", table: "mail_events" });
    const owner = datastoreKey({ engine: "Postgres", database: null, table: "MAIL_EVENTS" });
    assert.equal(writer, owner);
    assert.equal(writer, "postgres://?/mail_events");
  });

  test("configKey carries no service qualifier", () => {
    // The point of the node is that two readers of one env var are coupled.
    // Per-service keys would make R38's configuration dependency permanently
    // empty and nothing would report that it was.
    assert.equal(configKey("DATABASE_URL"), "env:DATABASE_URL");
    assert.equal(ref.config("DATABASE_URL").key, ref.config("DATABASE_URL").key);
  });
});

describe("global identity", () => {
  test("a symbol in one repo links to a route in another with no mapping table", () => {
    const store = new FactStore(join(dir, "global.db"));
    try {
      const front = store.upsertRepo("60-kri-next", "/tmp/front", "60-kri-next");
      const back = store.upsertRepo("40-kri-router", "/tmp/back", "40-kri-router");
      const runId = store.startRun(front, "static", "scip@0.4.0", "");

      const w = new GraphWriter(store, runId, front, {
        localPackages: new Set(["60-kri-next"]),
      });

      const caller = ref.symbol("scip-typescript npm 60-kri-next 0.1.0 `lib/api.ts`/post().");
      const remote = ref.route("40-kri-router", "POST", "/api/v1/po");
      w.edge({
        src: caller, dst: remote, type: "REQUESTS",
        confidence: "inferred", evidenceKind: "treesitter",
      });

      // One join, two repos, no translation step.
      const row = store.raw().prepare(
        `SELECT s.key AS src, d.key AS dst, e.confidence
           FROM edges e
           JOIN nodes s ON s.id = e.src_node_id
           JOIN nodes d ON d.id = e.dst_node_id
          WHERE e.type = 'REQUESTS'`,
      ).get() as { src: string; dst: string; confidence: string };
      assert.equal(row.dst, "40-kri-router POST /api/v1/po");
      assert.equal(row.confidence, "inferred", "cross-service is never certain (R31)");
      assert.ok(back > 0);
    } finally { store.close(); }
  });

  test("the same key from two writers resolves to one node", () => {
    const store = new FactStore(join(dir, "shared.db"));
    try {
      const a = store.upsertRepo("41-kri-engine", "/tmp/a", "41-kri-engine");
      const b = store.upsertRepo("51-integration", "/tmp/b", "51-integration");
      const runA = store.startRun(a, "static", "scip@0.4.0", "");
      const runB = store.startRun(b, "static", "scip-python@0.6.0", "");

      const wa = new GraphWriter(store, runA, a, { localPackages: new Set(["41-kri-engine"]) });
      const wb = new GraphWriter(store, runB, b, { localPackages: new Set(["51-integration"]) });

      const table = ref.datastore({ engine: "postgres", table: "mail_events" });
      wa.edge({
        src: ref.symbol("scip npm 41-kri-engine 1 `server.js`/init()."), dst: table,
        type: "WRITES", confidence: "inferred", evidenceKind: "treesitter",
      });
      wb.edge({
        src: ref.symbol("scip python 51-integration 1 `main.py`/send()."), dst: table,
        type: "WRITES", confidence: "inferred", evidenceKind: "treesitter",
      });

      const n = store.raw().prepare(
        "SELECT COUNT(*) AS n FROM nodes WHERE kind = 'datastore'",
      ).get() as { n: number };
      assert.equal(n.n, 1, "one datastore node, two writers — the coupling is a join");
      assert.equal(store.countRows("edges"), 2);
    } finally { store.close(); }
  });
});

describe("GraphWriter", () => {
  test("foreign symbols collapse onto their package as an external node", () => {
    const store = new FactStore(join(dir, "external.db"));
    try {
      const repoId = store.upsertRepo("40-kri-router", "/tmp/r", "40-kri-router");
      const runId = store.startRun(repoId, "static", "scip@0.4.0", "");
      const w = new GraphWriter(store, runId, repoId, {
        localPackages: new Set(["40-kri-router"]),
      });

      const get = w.symbolNode("scip-typescript npm axios 1.7.2 `index.d.ts`/get().");
      const post = w.symbolNode("scip-typescript npm axios 1.7.2 `index.d.ts`/post().");
      assert.equal(get.external, true);
      assert.equal(get.id, post.id, "two axios functions, one boundary node");

      const key = (store.raw().prepare("SELECT key FROM nodes WHERE id = ?")
        .get(get.id) as { key: string }).key;
      assert.equal(key, "npm:axios@1.7.2");

      const own = w.symbolNode("scip-typescript npm 40-kri-router 1.0.0 `server.js`/forward().");
      assert.equal(own.external, false);
      assert.equal(own.kind, "symbol");
    } finally { store.close(); }
  });

  test("a local symbol is never an external node, and vice versa", () => {
    const store = new FactStore(join(dir, "boundary.db"));
    try {
      const repoId = store.upsertRepo("r", "/tmp/r", "r");
      const runId = store.startRun(repoId, "static", "scip@0.4.0", "");
      const w = new GraphWriter(store, runId, repoId, { localPackages: new Set(["mine"]) });

      assert.equal(w.isLocalSymbol("scip npm mine 1 `a.ts`/f()."), true);
      assert.equal(w.isLocalSymbol("scip npm theirs 1 `a.ts`/f()."), false);
      // A function-scoped local has no stable identity across reindexing, so
      // it is never treated as one of ours.
      assert.equal(w.isLocalSymbol("local 12"), false);
    } finally { store.close(); }
  });

  test("node ids are cached, so a re-referenced key costs no second lookup", () => {
    const store = new FactStore(join(dir, "cache.db"));
    try {
      const repoId = store.upsertRepo("r", "/tmp/r", "r");
      const runId = store.startRun(repoId, "static", "scip@0.4.0", "");
      const w = new GraphWriter(store, runId, repoId, { localPackages: new Set(["mine"]) });
      const first = w.node(ref.service("svc"));
      const second = w.node(ref.service("svc"));
      assert.equal(first, second);
      assert.equal(w.touchedNodes, 1);
    } finally { store.close(); }
  });
});
