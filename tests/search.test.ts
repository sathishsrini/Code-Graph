// Tests for P3-T3 (R43 seeding, R66 RRF, R67 vectors).
//
// The bet here is a specific one: the FTS5 tokenizer reads `checkUserAuth` as
// the single token `checkuserauth`, while a person describing the workflow
// says "check user auth". The search table is indexed around that gap (name /
// qualified / squash columns) and this suite asserts the gap is actually
// closed, plus that a wrong-but-confident seeding can always be overridden and
// that lexical and vector signals agree only where the evidence supports it.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactStore } from "../src/store/db.ts";
import { buildSearchIndex } from "../src/index/search.ts";
import { search, tokensOf } from "../src/query/workflow.ts";
import {
  VectorIndex, toBlob, fromBlob, type EmbeddingProvider,
} from "../src/retrieval/vector-store.ts";
import { applyRRF, type RrfCandidate } from "../src/retrieval/rrf.ts";

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), "code-intel-search-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

const SYM = (svc: string, name: string) => `scip npm ${svc} 1 \`server.js\`/${name}().`;

interface Ctx {
  store: FactStore;
  svc: string;
  node: (kind: Parameters<FactStore["upsertNode"]>[0], key: string) => number;
  sym: (name: string) => number;
  route: (method: string, url: string) => number;
}

function ctx(store: FactStore, svc = "svc"): Ctx {
  const repoId = store.upsertRepo(svc, `/tmp/${svc}`, svc);
  const runId = store.startRun(repoId, "static", "test@0", "");
  store.upsertFile(repoId, "server.js", "js", `h-${svc}`, runId);
  const node = (kind: Parameters<FactStore["upsertNode"]>[0], key: string) =>
    store.upsertNode(kind, key, repoId);
  const sym = (name: string) => {
    const id = node("symbol", SYM(svc, name));
    store.upsertSymbol({
      nodeId: id, fileId: 1, displayName: name, symbolKind: "method", startLine: 1,
    });
    return id;
  };
  const route = (method: string, url: string) => {
    const id = node("route", `${svc} ${method} ${url}`);
    store.upsertRoute({
      nodeId: id, repoId, serviceName: svc, method, url, source: "boot", runId,
    });
    return id;
  };
  return { store, svc, node, sym, route };
}

// ---------------------------------------------------------------------------

describe("FTS5 token premise", () => {
  test("checkUserAuth indexes as one token, so a phrase with spaces cannot match it directly", () => {
    // Assert the premise the whole squash design rests on: FTS5's porter stemmer
    // + unicode61 folds `checkUserAuth` into a single `checkuserauth` token.
    const store = new FactStore(join(dir, "premise.db"));
    try {
      const c = ctx(store);
      c.sym("checkUserAuth");
      c.sym("unrelated");
      buildSearchIndex(store);

      const db = store.raw();
      const single = db
        .prepare(`SELECT node_key FROM search WHERE search MATCH '"checkuserauth"'`)
        .all() as Array<{ node_key: string }>;
      assert.equal(single.length, 1);
      assert.ok(single[0]!.node_key.includes("checkUserAuth"));

      const spaced = db
        .prepare(`SELECT node_key FROM search WHERE search MATCH '"check" AND "user" AND "auth"'`)
        .all() as Array<{ node_key: string }>;
      assert.equal(spaced.length, 0);
    } finally { store.close(); }
  });
});

describe("buildSearchIndex", () => {
  test("rows mirror the store; a rebuild is idempotent", () => {
    const store = new FactStore(join(dir, "build.db"));
    try {
      const c = ctx(store);
      c.sym("forward");
      c.sym("fetchOrder");
      c.route("POST", "/api/v1/po");

      const first = buildSearchIndex(store);
      assert.equal(first.rows, 3);
      assert.equal(first.provider, null);

      const second = buildSearchIndex(store);
      assert.equal(second.rows, 3);

      const meta = store.raw().prepare(`SELECT rows FROM search_meta WHERE id = 1`).get() as { rows: number };
      assert.equal(meta.rows, 3);
    } finally { store.close(); }
  });
});

describe("stage-1 seeding", () => {
  test("an exact identifier phrase seeds the symbol", () => {
    const store = new FactStore(join(dir, "exact.db"));
    try {
      const c = ctx(store);
      c.sym("checkUserAuth");
      buildSearchIndex(store);

      const wf = search(store, "checkUserAuth");
      assert.equal(wf.notBuilt, false);
      assert.ok(wf.chosen, "expected a seed");
      assert.ok(wf.chosen.nodeKey.includes("checkUserAuth"));
      assert.equal(wf.chosen.kind, "symbol");
      assert.ok(wf.chosen.sources.some((s) => s.startsWith("lexical")));
    } finally { store.close(); }
  });

  test('a spaced phrase "check user auth" lands via the fused phrase signal', () => {
    const store = new FactStore(join(dir, "fuzzy.db"));
    try {
      const c = ctx(store);
      c.sym("checkUserAuth");
      c.sym("unrelated");
      buildSearchIndex(store);

      const wf = search(store, "check user auth");
      assert.ok(wf.chosen, `expected a seed; reason: ${wf.reason}`);
      assert.ok(wf.chosen.nodeKey.includes("checkUserAuth"));
    } finally { store.close(); }
  });

  test("an inexact casing with no separator still lands", () => {
    const store = new FactStore(join(dir, "case.db"));
    try {
      const c = ctx(store);
      c.sym("checkUserAuth");
      buildSearchIndex(store);
      assert.equal(search(store, "CHECKUSERAUTH").chosen?.nodeKey.includes("checkUserAuth"), true);
      assert.equal(search(store, "checkuserauth").chosen?.nodeKey.includes("checkUserAuth"), true);
    } finally { store.close(); }
  });

  test("a route phrase seeds the route and stages the endpoint-flow follow", () => {
    const store = new FactStore(join(dir, "route.db"));
    try {
      const c = ctx(store);
      c.route("POST", "/api/v1/po");
      c.route("GET", "/health");
      buildSearchIndex(store);

      const wf = search(store, "POST api v1 po", { topK: 3 });
      assert.ok(wf.chosen);
      assert.equal(wf.chosen.kind, "route");
      assert.equal(wf.chosen.display, "POST /api/v1/po");
      assert.equal(wf.follow?.query, "endpoint_flow");
      assert.deepEqual(wf.follow, {
        query: "endpoint_flow", service: "svc", method: "POST", url: "/api/v1/po",
      });
    } finally { store.close(); }
  });

  test("searching before any build reports not-built with the build hint", () => {
    const store = new FactStore(join(dir, "unbuilt.db"));
    try {
      ctx(store).sym("unindexed");
      const wf = search(store, "unindexed");
      assert.equal(wf.notBuilt, true);
      assert.equal(wf.chosen, null);
      assert.match(wf.reason, /search build/);
    } finally { store.close(); }
  });

  test("no-match on a phrase outside the corpus", () => {
    const store = new FactStore(join(dir, "none.db"));
    try {
      ctx(store).sym("onlyReal");
      buildSearchIndex(store);
      const wf = search(store, "utterly imaginary thing");
      assert.equal(wf.chosen, null);
      assert.match(wf.reason, /nothing in the index matched/);
    } finally { store.close(); }
  });

  test("stage-1 is deterministic: identical input, identical output", () => {
    const store = new FactStore(join(dir, "det.db"));
    try {
      const c = ctx(store);
      c.sym("checkUserAuth");
      c.sym("fetchOrder");
      c.route("POST", "/api/v1/po");
      buildSearchIndex(store);

      const a = search(store, "user auth");
      const b = search(store, "user auth");
      assert.deepEqual(a.chosen, b.chosen);
      assert.equal(a.candidates.length, b.candidates.length);
      for (let i = 0; i < a.candidates.length; i++) {
        assert.deepEqual(a.candidates[i], b.candidates[i]);
      }
    } finally { store.close(); }
  });
});

describe("correction affordance", () => {
  test("an explicit seed overrides stage 1 even when stage 1 was confident", () => {
    const store = new FactStore(join(dir, "correct.db"));
    try {
      const c = ctx(store);
      c.sym("forward");
      c.sym("forwarding");
      buildSearchIndex(store);

      // Stage 1 is confident and points at "forward"; a reviewer decides the
      // singular `forwarding` function is the real intent.
      const wrong = search(store, "forward");
      assert.ok(wrong.chosen, `expected stage-1 confidence; reason: ${wrong.reason}`);

      const key = SYM(c.svc, "forwarding");
      const wf = search(store, "forward", { correctedSeed: key });
      assert.equal(wf.chosen?.nodeKey, key);
      assert.deepEqual(wf.chosen?.sources, ["user-seed"]);
      assert.equal(wf.follow?.query, "impact");
      assert.equal(wf.follow?.query === "impact" ? wf.follow.seed : "", key);
      assert.equal(wf.correctedSeed, key);
    } finally { store.close(); }
  });

  test("a missing correction is refused, not guessed", () => {
    const store = new FactStore(join(dir, "correct-miss.db"));
    try {
      ctx(store).sym("real");
      buildSearchIndex(store);
      const wf = search(store, "real", { correctedSeed: "scip npm none 0 `x.js`/gone()." });
      assert.equal(wf.chosen, null);
      assert.match(wf.reason, /not a node/);
    } finally { store.close(); }
  });
});

describe("vector signal + RRF (R67, R66)", () => {
  const fakeProvider = (
    name: string,
    map: Record<string, number[]>,
  ): EmbeddingProvider => ({
    name,
    dimension: 4,
    embed(text: string): Float32Array {
      const v = new Float32Array(4);
      for (const tok of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
        const known = map[tok];
        if (known) {
          for (let i = 0; i < known.length; i++) v[i]! += known[i]!;
        }
      }
      const norm = Math.hypot(...v) || 1;
      for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
      return v;
    },
  });

  test("a vector-only hit seeds a seed lexical search would miss", () => {
    const store = new FactStore(join(dir, "vector-only.db"));
    try {
      const c = ctx(store);
      c.sym("forward"); // text: "forward server.js"
      c.sym("unrelated");
      buildSearchIndex(store, {
        embeddings: fakeProvider("fake:test", {
          forward: [1, 0, 0, 0],
          send: [0.9, 0.1, 0, 0],
        }),
      });

      // "send" is not a token anywhere in the corpus, so lexical finds nothing;
      // the provider maps it close to the "forward" row's embedding.
      const wf = search(store, "send", { embeddings: fakeProvider("fake:test", { send: [0.9, 0.1, 0, 0] }) });
      assert.ok(wf.chosen, `expected a vector seed; reason: ${wf.reason}`);
      assert.ok(wf.chosen.nodeKey.includes("forward"));
      assert.ok(wf.chosen.sources.some((s) => s.startsWith("vector:fake")));
      assert.equal(wf.chosen.bm25, null);
      assert.ok(wf.chosen.cosine !== null && wf.chosen.cosine > 0.5);
    } finally { store.close(); }
  });

  test("agreement across signals outranks agreement with one (RRF)", () => {
    const store = new FactStore(join(dir, "rrf.db"));
    try {
      const c = ctx(store);
      const forwardKey = SYM(c.svc, "forward");
      c.sym("forward");
      c.sym("forwarding"); // lexical-only friend: matches via the prefix aspect
      c.sym("unrelated");
      buildSearchIndex(store, {
        // Only `forward` maps to a real embedding. `forwarding` embeds to the
        // zero vector — cosine 0 — which the solver treats as "no evidence"
        // and keeps out of the merge, leaving it lexical-only.
        embeddings: fakeProvider("fake:agree", { forward: [1, 0, 0, 0] }),
      });

      // With vectors, "forward" and "forwarding" both rank lexically; only
      // "forward" is also corroborated by the vector signal.
      const wf = search(store, "forward", {
        topK: 5,
        embeddings: fakeProvider("fake:agree", { forward: [1, 0, 0, 0] }),
      });
      assert.ok(wf.chosen);
      assert.equal(wf.chosen.nodeKey, forwardKey);
      const forward = wf.candidates.find((c) => c.nodeKey === forwardKey);
      const forwarding = wf.candidates.find((c) => c.nodeKey.includes("forwarding"));
      assert.ok(forward && forwarding);
      assert.ok(forward.sources.some((s) => s.startsWith("vector")));
      assert.ok(!forwarding.sources.some((s) => s.startsWith("vector")));
      assert.ok(forward.score > forwarding.score);
    } finally { store.close(); }
  });

  test("vectors are persisted as blobs and survive a fresh provider", () => {
    const store = new FactStore(join(dir, "blob.db"));
    try {
      const c = ctx(store);
      c.sym("forward");
      buildSearchIndex(store, { embeddings: fakeProvider("f:b", { forward: [1, 0, 0, 0] }) });
      const blob = store.raw().prepare(`SELECT vector FROM search_vectors LIMIT 1`).get() as { vector: Uint8Array };
      assert.ok(blob.vector.byteLength > 0);
      const v = fromBlob(new Uint8Array(blob.vector));
      assert.equal(v[0], 1);
      assert.equal(v[1], 0);
    } finally { store.close(); }
  });
});

describe("VectorIndex primitives", () => {
  test("blob round-trips a Float32Array exactly", () => {
    const a = new Float32Array([1.5, -2.25, 0, 4]);
    const b = fromBlob(toBlob(a));
    assert.deepEqual(Array.from(b), Array.from(a));
  });

  test("toBlob refuses a corrupt buffer", () => {
    assert.throws(() => fromBlob(new Uint8Array([1, 2, 3])), /truncated|magic/);
  });

  test("cosine: identical, orthogonal, and dimension mismatch", () => {
    const idx = new VectorIndex();
    idx.upsert("a", new Float32Array([1, 0, 0]));
    idx.upsert("b", new Float32Array([0, 1, 0]));
    const top = idx.search(new Float32Array([1, 0, 0]), 2);
    assert.equal(top[0]!.id, "a");
    assert.ok(Math.abs(top[0]!.score - 1) < 1e-6);
    assert.ok(Math.abs(top[1]!.score) < 1e-6);
    assert.throws(() => idx.search(new Float32Array([1, 0]), 1), /dimension/);
  });
});

describe("applyRRF", () => {
  test("merges ranks, rank 1 in both signals wins", () => {
    const sets = [
      [{ id: "a", source: "lex" }, { id: "b", source: "lex" }],
      [{ id: "a", source: "vec" }, { id: "c", source: "vec" }],
    ];
    const merged = applyRRF(sets, 60);
    assert.equal(merged[0]!.id, "a");
    assert.equal(merged[0]!.retrievalCount, 2);
    assert.deepEqual(merged[0]!.sources, ["lex", "vec"]);
  });

  test("is deterministic: identical intake produces an identical ranking", () => {
    const intake: RrfCandidate[][] = [
      [{ id: "x", source: "s" }, { id: "y", source: "s" }],
      [{ id: "y", source: "t" }, { id: "z", source: "t" }],
    ];
    assert.deepEqual(applyRRF(intake, 60), applyRRF(intake, 60));
  });

  test("rank position, not score magnitude, drives the merge", () => {
    const merged = applyRRF([
      [{ id: "a", source: "cold", score: 0.001 }, { id: "b", source: "cold", score: 1000 }],
      [{ id: "b", source: "warm", score: 1000 }],
    ], 60);
    // `b` holds rank 1 in the second signal and rank 2 in the first; `a` only
    // rank 1 in the first. RRF never looks at the raw scores, only ranks.
    assert.equal(merged[0]!.id, "b");
    assert.equal(merged[0]!.retrievalCount, 2);
  });
});

describe("tokensOf", () => {
  test("splits words but ignores punctuation and case-folds nothing", () => {
    assert.deepEqual(tokensOf("check  USER-auth!"), ["check", "USER", "auth"]);
    assert.deepEqual(tokensOf(",,,"), []);
  });
});