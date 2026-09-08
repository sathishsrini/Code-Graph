// Tests for the TOON encoder and context_pack (task P1-T15, R42/R44/R71).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactStore } from "../src/store/db.ts";
import { encodeToon, estimateTokens } from "../src/serializers/toon.ts";
import { contextPack, packToToon, TIERS } from "../src/query/context-pack.ts";

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), "code-intel-pack-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

describe("TOON encoder (R44)", () => {
  test("a uniform array becomes one header and bare rows", () => {
    const out = encodeToon({
      edges: [
        { src: "a", dst: "b", type: "CALLS" },
        { src: "b", dst: "c", type: "CALLS" },
      ],
    });
    assert.equal(out.split("\n")[0], "edges[2]{src,dst,type}:");
    assert.ok(out.includes("  a,b,CALLS"));
  });

  test("it is materially smaller than JSON for the shape a graph returns", () => {
    // The entire reason R44 exists. Field names once, not once per row.
    const rows = Array.from({ length: 40 }, (_, i) => ({
      source: `sym${i}`, target: `dst${i}`, type: "CALLS", confidence: "certain",
    }));
    const toon = estimateTokens(encodeToon({ edges: rows }));
    const json = estimateTokens(JSON.stringify({ edges: rows }));
    assert.ok(toon < json * 0.6, `toon ${toon} vs json ${json}`);
  });

  test("a value containing a comma is quoted, so the table stays aligned", () => {
    // Without this a SQL fragment in `detail` becomes three columns and every
    // row after it is misread.
    const out = encodeToon({ rows: [{ a: "1", detail: "INSERT INTO t (x, y)" }] });
    assert.ok(out.includes('"INSERT INTO t (x, y)"'));
  });

  test("a newline in a value does not break the row", () => {
    const out = encodeToon({ rows: [{ a: "x", b: "line1\nline2" }] });
    assert.equal(out.split("\n").length, 2, "header + one row");
    assert.ok(out.includes("\\n"));
  });

  test("a ragged array falls back to blocks rather than inventing empty cells", () => {
    // A blank in a table reads as "this field is empty"; the truth is "this
    // item has no such field".
    const out = encodeToon({ items: [{ a: 1 }, { a: 1, b: 2 }] });
    assert.ok(!out.includes("{a}:"), "not rendered as a uniform table");
    assert.ok(out.startsWith("items[2]:"));
  });

  test("the array header form is consistent — the ported bug is fixed", () => {
    // The original emitted `N rows{…}` here while its own parser matched only
    // `key[N]{…}`, so a bare array never round-tripped (plan §5).
    const out = encodeToon([{ a: 1 }, { a: 2 }], { rootName: "edges" });
    assert.ok(out.startsWith("edges[2]{a}:"), out.slice(0, 40));
  });

  test("empty and scalar arrays have their own forms", () => {
    assert.equal(encodeToon({ x: [] }), "x[0]:");
    assert.equal(encodeToon({ x: [1, 2, 3] }), "x[3]: 1,2,3");
  });
});

// ---------------------------------------------------------------------------

interface Ctx {
  store: FactStore;
  repoId: number;
  runId: number;
  fileId: number;
  sym: (name: string, line?: number) => number;
  calls: (src: number, dst: number, line: number) => void;
}

function ctx(store: FactStore): Ctx {
  const repoId = store.upsertRepo("svc", "/tmp/svc", "svc");
  const runId = store.startRun(repoId, "static", "test@0", "");
  const fileId = store.upsertFile(repoId, "server.js", "js", "h", runId);
  store.upsertNode("file", "svc/server.js", repoId);

  const sym = (name: string, line = 1) => {
    const id = store.upsertNode("symbol", `scip npm svc 1 \`server.js\`/${name}().`, repoId);
    store.upsertSymbol({
      nodeId: id, fileId, displayName: name, symbolKind: "method",
      signature: `function ${name}()`, startLine: line, endLine: line + 5,
    });
    return id;
  };
  const calls = (src: number, dst: number, line: number) =>
    store.insertEdge({
      srcNodeId: src, dstNodeId: dst, type: "CALLS", confidence: "certain",
      evidenceKind: "scip", fileId, line, runId,
    });
  return { store, repoId, runId, fileId, sym, calls };
}

describe("context_pack tiers (R42)", () => {
  test("callees, callers and transitive land in their own tiers", () => {
    const store = new FactStore(join(dir, "tiers.db"));
    try {
      const c = ctx(store);
      const seed = c.sym("seed", 10);
      const callee = c.sym("callee", 20);
      const deep = c.sym("deep", 30);
      const caller = c.sym("caller", 40);
      c.calls(seed, callee, 11);
      c.calls(callee, deep, 21);
      c.calls(caller, seed, 41);

      const pack = contextPack(store, "seed", { includeSource: false });
      const tierOf = (n: string) => pack.items.find((i) => i.name === n)?.tier;
      assert.equal(tierOf("callee"), "callees");
      assert.equal(tierOf("caller"), "callers");
      assert.equal(tierOf("deep"), "transitive");
    } finally { store.close(); }
  });

  test("the nine tiers are filled in priority order", () => {
    assert.deepEqual([...TIERS], [
      "seed", "callees", "callers", "routes", "security",
      "config", "datastores", "transitive", "gaps",
    ]);
  });

  test("a tight budget drops low tiers and NAMES what it dropped", () => {
    // A reader who knows `transitive` was dropped can ask for more budget; one
    // who does not assumes there was nothing there.
    const store = new FactStore(join(dir, "budget.db"));
    try {
      const c = ctx(store);
      const seed = c.sym("seed", 10);
      for (let i = 0; i < 30; i += 1) {
        const callee = c.sym(`callee${i}`, 100 + i);
        c.calls(seed, callee, 11 + i);
        c.calls(callee, c.sym(`deep${i}`, 200 + i), 300 + i);
      }

      const tight = contextPack(store, "seed", { budget: 200, includeSource: false });
      assert.ok(tight.droppedTiers.length > 0, "something was dropped");
      assert.ok(tight.usedTokens <= 200 + 50, `used ${tight.usedTokens}`);

      const roomy = contextPack(store, "seed", { budget: 100000, includeSource: false });
      assert.deepEqual(roomy.droppedTiers, []);
    } finally { store.close(); }
  });

  test("gaps survive any budget — tier 9 is reserved, never dropped", () => {
    // A pack that silently omits the gaps tells the reader the picture is
    // complete, which is the one claim this engine must never make.
    const store = new FactStore(join(dir, "gaps-budget.db"));
    try {
      const c = ctx(store);
      const seed = c.sym("seed", 10);
      for (let i = 0; i < 40; i += 1) c.calls(seed, c.sym(`x${i}`, 100 + i), 11 + i);
      store.insertUnresolved({
        srcNodeId: seed, kind: "call", targetHint: "npm axios",
        reason: "callee resolved to a package", fileId: c.fileId, line: 68, runId: c.runId,
      });

      const pack = contextPack(store, "seed", { budget: 60, includeSource: false });
      assert.ok(pack.includedTiers.includes("gaps"));
      assert.equal(pack.items.filter((i) => i.tier === "gaps").length, 1);
    } finally { store.close(); }
  });

  test("no raw source below tier 1", () => {
    const store = new FactStore(join(dir, "nosource.db"));
    try {
      const c = ctx(store);
      const seed = c.sym("seed", 10);
      c.calls(seed, c.sym("callee", 20), 11);
      const pack = contextPack(store, "seed", { includeSource: false });
      assert.equal(pack.source, null);
      for (const item of pack.items.filter((i) => i.tier !== "seed")) {
        assert.ok(
          !item.detail.includes("\n") || item.detail.startsWith("```"),
          "neighbours carry a signature, never a body",
        );
      }
    } finally { store.close(); }
  });
});

describe("routes and security context", () => {
  test("a route running the seed, and its checks, are packed", () => {
    const store = new FactStore(join(dir, "routes.db"));
    try {
      const c = ctx(store);
      const seed = c.sym("handler", 10);
      const route = store.upsertNode("route", "svc POST /p", c.repoId);
      store.upsertRoute({
        nodeId: route, repoId: c.repoId, serviceName: "svc", method: "POST",
        url: "/p", source: "boot", runId: c.runId,
      });
      store.insertChainEntry({
        routeNodeId: route, position: 0, phase: "handler", origin: "route",
        symbolNodeId: seed, confidence: "certain", evidenceKind: "boot",
        fileId: c.fileId, line: 10, runId: c.runId,
      });
      store.insertChainEntry({
        routeNodeId: route, position: 0, phase: "handler_inline", origin: "handler",
        name: "checkUserAuth", checkKind: "auth", confidence: "inferred",
        evidenceKind: "treesitter", fileId: c.fileId, line: 11, runId: c.runId,
      });

      const pack = contextPack(store, "handler", { includeSource: false });
      assert.ok(pack.items.some((i) => i.tier === "routes" && i.name === "POST /p"));
      const check = pack.items.find((i) => i.tier === "security");
      assert.equal(check?.name, "checkUserAuth");
      assert.ok(
        check?.detail.includes("inferred"),
        "the weaker channel is carried into the pack, not flattened",
      );
    } finally { store.close(); }
  });

  test("a file-scoped config read is labelled as such in the pack", () => {
    const store = new FactStore(join(dir, "cfg.db"));
    try {
      const c = ctx(store);
      const seed = c.sym("handler", 10);
      const fileNode = store.upsertNode("file", "svc/server.js", c.repoId);
      store.insertEdge({
        srcNodeId: fileNode,
        dstNodeId: store.upsertNode("config", "env:PORT", null),
        type: "READS_CONFIG", confidence: "inferred", evidenceKind: "treesitter",
        fileId: c.fileId, line: 6, runId: c.runId,
      });
      const pack = contextPack(store, "handler", { includeSource: false });
      const cfg = pack.items.find((i) => i.tier === "config");
      assert.equal(cfg?.name, "env:PORT");
      assert.equal(cfg?.where, "[file-scope]", "never read as the function's own");
      assert.ok(seed > 0);
    } finally { store.close(); }
  });
});

describe("output", () => {
  test("packToToon groups by tier and names dropped tiers", () => {
    const store = new FactStore(join(dir, "out.db"));
    try {
      const c = ctx(store);
      const seed = c.sym("seed", 10);
      c.calls(seed, c.sym("callee", 20), 11);
      const text = packToToon(contextPack(store, "seed", { includeSource: false }));
      assert.ok(text.includes("seed: seed"));
      assert.ok(text.includes("callees[1]{name,detail,where}:"));
    } finally { store.close(); }
  });
});
