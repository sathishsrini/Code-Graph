// Tests for the TOON encoder and context_pack (task P1-T15, R42/R44/R71).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactStore } from "../src/store/db.ts";
import { encodeToon, estimateTokens } from "../src/serializers/toon.ts";
import {
  contextPack, packToToon, TIERS, measureReadRanges,
} from "../src/query/context-pack.ts";

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

// ---------------------------------------------------------------------------
// CTX-S7: read ranges. Claude Code's edit tool needs a prior Read of the file,
// and Read takes offset/limit, so the pack hands over exact line ranges for
// the seed and its direct callees and callers, straight from `symbols`.
// ---------------------------------------------------------------------------

describe("read ranges (CTX-S7)", () => {
  /** A symbol with an explicit stored range; `end: null` stores no end line. */
  function ranged(
    c: Ctx, name: string, start: number, end: number | null, symbolKind = "method",
  ): number {
    const id = c.store.upsertNode("symbol", `scip npm svc 1 \`server.js\`/${name}().`, c.repoId);
    c.store.upsertSymbol({
      nodeId: id, fileId: c.fileId, displayName: name, symbolKind,
      signature: `function ${name}()`, startLine: start, endLine: end ?? undefined,
    });
    return id;
  }
  const FILE = join("/tmp/svc", "server.js");

  test("the seed, a direct callee and a direct caller carry their exact stored ranges", () => {
    const store = new FactStore(join(dir, "ranges.db"));
    try {
      const c = ctx(store);
      const seed = ranged(c, "seed", 10, 18);
      const callee = ranged(c, "callee", 40, 52);
      const caller = ranged(c, "caller", 80, 95);
      c.calls(seed, callee, 12);
      c.calls(caller, seed, 85);

      const pack = contextPack(store, "seed", { includeSource: false });
      assert.deepEqual(pack.readRanges, [
        { file: FILE, start: 10, end: 18, symbols: ["seed:seed"] },
        { file: FILE, start: 40, end: 52, symbols: ["callee:callee"] },
        { file: FILE, start: 80, end: 95, symbols: ["caller:caller"] },
      ]);
      assert.deepEqual(pack.readRangeGaps, []);

      const text = packToToon(pack);
      assert.ok(text.includes("readRanges[3]{file,start,end,symbols}:"), text);
      assert.ok(text.includes(`${FILE},10,18,seed:seed`));
      assert.ok(text.includes(`${FILE},80,95,caller:caller`));
    } finally { store.close(); }
  });

  test("a symbol without an end line is a gap, never a fabricated range", () => {
    const store = new FactStore(join(dir, "ranges-noend.db"));
    try {
      const c = ctx(store);
      const seed = ranged(c, "seed", 10, 18);
      c.calls(seed, ranged(c, "open", 40, null), 12);

      const pack = contextPack(store, "seed", { includeSource: false });
      assert.deepEqual(pack.readRanges.map((r) => r.symbols), [["seed:seed"]]);
      assert.ok(!pack.readRanges.some((r) => r.start === 40), "no invented end for line 40");
      assert.equal(pack.readRangeGaps.length, 1);
      const gap = pack.readRangeGaps[0]!;
      assert.equal(gap.symbol, "callee:open");
      assert.equal(gap.file, FILE);
      assert.deepEqual(gap.lines, [40], "the start line, so the reader knows where to begin");
      assert.match(gap.reason, /no end line/);
      assert.ok(packToToon(pack).includes("readRangeGaps[1]{symbol,file,line,reason}:"));
    } finally { store.close(); }
  });

  test("ranges are never dropped for budget", () => {
    const store = new FactStore(join(dir, "ranges-budget.db"));
    try {
      const c = ctx(store);
      const seed = ranged(c, "seed", 10, 18);
      for (let i = 0; i < 20; i += 1) c.calls(seed, ranged(c, `x${i}`, 100 + i * 10, 105 + i * 10), 11);
      const pack = contextPack(store, "seed", { budget: 10, includeSource: false });
      assert.ok(pack.droppedTiers.includes("callees"), "the tier itself was dropped");
      assert.equal(pack.readRanges.length, 21, "its ranges were not");
    } finally { store.close(); }
  });

  test("overlapping or touching ranges merge; a gap of one line does not", () => {
    // Overlap is the nested-function case: reading both ranges would read the
    // inner one twice. Across a gap, merging would read lines nobody asked for.
    const store = new FactStore(join(dir, "ranges-merge.db"));
    try {
      const c = ctx(store);
      const seed = ranged(c, "seed", 10, 30);
      c.calls(seed, ranged(c, "inner", 12, 20), 25);
      c.calls(ranged(c, "next", 31, 35), seed, 33);
      c.calls(ranged(c, "apart", 37, 40), seed, 38);

      const pack = contextPack(store, "seed", { includeSource: false });
      assert.deepEqual(pack.readRanges, [
        { file: FILE, start: 10, end: 35, symbols: ["seed:seed", "callee:inner", "caller:next"] },
        { file: FILE, start: 37, end: 40, symbols: ["caller:apart"] },
      ]);
    } finally { store.close(); }
  });

  test("a module-scope caller is a gap at its call lines, not a whole-file range", () => {
    // SCIP credits a call inside an anonymous handler to the module, whose
    // stored range is the whole file. Handing that over as a "range" would be
    // the whole-file read this slice exists to avoid.
    const store = new FactStore(join(dir, "ranges-module.db"));
    try {
      const c = ctx(store);
      const seed = ranged(c, "seed", 10, 18);
      const mod = store.upsertNode("symbol", "scip npm svc 1 `server.js`/", c.repoId);
      store.upsertSymbol({
        nodeId: mod, fileId: c.fileId, displayName: "server.js", symbolKind: "namespace",
        startLine: 1, endLine: 400,
      });
      c.calls(mod, seed, 292);
      c.calls(mod, seed, 310);

      const pack = contextPack(store, "seed", { includeSource: false });
      assert.deepEqual(pack.readRanges.map((r) => [r.start, r.end]), [[10, 18]]);
      assert.equal(pack.readRangeGaps.length, 1);
      assert.deepEqual(pack.readRangeGaps[0]!.lines, [292, 310], "the call sites");
      assert.match(pack.readRangeGaps[0]!.reason, /module scope/);
      assert.ok(packToToon(pack).includes(`caller:server.js,${FILE},292|310,`));
    } finally { store.close(); }
  });

  test("Read(ranges) is measured against Read(whole files), gutter included", () => {
    // Real bytes on disk, reached through a `repoRoots` override as tier 1 is.
    const store = new FactStore(join(dir, "ranges-measure.db"));
    const root = join(dir, "measure-root");
    try {
      mkdirSync(root, { recursive: true });
      const lines = Array.from({ length: 20 }, (_, i) => `l${String(i + 1).padStart(2, "0")}`);
      writeFileSync(join(root, "server.js"), lines.join("\n") + "\n");
      const c = ctx(store);
      ranged(c, "seed", 3, 5);

      const pack = contextPack(store, "seed", {
        includeSource: false, repoRoots: new Map([["svc", root]]),
      });
      assert.equal(pack.readRanges[0]!.file, join(root, "server.js"));
      const m = measureReadRanges(pack);
      assert.equal(m.rangeBytes, 3 * (3 + 1 + 7), "three lines, newline and gutter each");
      assert.equal(m.fileBytes, 80 + 20 * 7, "the whole file, same accounting");
      assert.deepEqual([m.ranges, m.files, m.gaps], [1, 1, 0]);
    } finally { store.close(); }
  });
});
