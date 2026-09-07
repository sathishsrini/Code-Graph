// Tests for endpoint_flow (task P1-T12, R35/R36).
//
// Built on a hand-seeded store rather than the corpus, so the suite stays
// hermetic and each requirement is exercised in isolation. Four of these are
// regression tests for defects the corpus surfaced only when the query was
// actually run — none of them failed a unit test first, which is the reason
// they are written down here now.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactStore } from "../src/store/db.ts";
import { endpointFlow, RouteNotFound, weakest } from "../src/query/endpoint-flow.ts";
import type { FlowNode } from "../src/query/endpoint-flow.ts";

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), "code-intel-flow-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

const SYM = (name: string) => `scip npm svc 1 \`server.js\`/${name}().`;
const MODULE = "scip npm svc 1 `server.js`/";

/**
 * One service, one route, a handler that calls two helpers.
 *
 * `deep` chains handler -> a -> b so depth and min_conf have something to
 * propagate through.
 */
function seed(store: FactStore, name = "svc") {
  const repoId = store.upsertRepo(name, `/tmp/${name}`, name);
  const runId = store.startRun(repoId, "static", "test@0", "");
  const fileId = store.upsertFile(repoId, "server.js", "js", "h", runId);

  const node = (kind: Parameters<FactStore["upsertNode"]>[0], key: string) =>
    store.upsertNode(kind, key, repoId);

  const route = node("route", `${name} POST /p`);
  store.upsertRoute({
    nodeId: route, repoId, serviceName: name, method: "POST", url: "/p",
    source: "boot", runId,
  });
  return { repoId, runId, fileId, route, node };
}

describe("min_conf propagation (R36)", () => {
  test("weakest picks the lower rank, in both argument orders", () => {
    assert.equal(weakest("certain", "inferred"), "inferred");
    assert.equal(weakest("inferred", "certain"), "inferred");
    assert.equal(weakest("inferred", "unresolved"), "unresolved");
    assert.equal(weakest("certain", "observed"), "observed");
    assert.equal(weakest("certain", "certain"), "certain");
  });

  test("one inferred hop makes every node below it inferred", () => {
    // The property that matters: a path is only as trustworthy as its weakest
    // edge, so nothing downstream of an inferred hop may render as fact.
    const store = new FactStore(join(dir, "minconf.db"));
    try {
      const { repoId, runId, fileId, route, node } = seed(store);
      const h = node("symbol", SYM("handler"));
      const a = node("symbol", SYM("a"));
      const b = node("symbol", SYM("b"));

      store.insertChainEntry({
        routeNodeId: route, position: 0, phase: "handler", origin: "route",
        symbolNodeId: h, confidence: "certain", evidenceKind: "boot",
        fileId, line: 1, runId,
      });
      store.insertEdge({
        srcNodeId: h, dstNodeId: a, type: "CALLS", confidence: "inferred",
        evidenceKind: "scip", fileId, line: 2, runId,
      });
      store.insertEdge({
        srcNodeId: a, dstNodeId: b, type: "CALLS", confidence: "certain",
        evidenceKind: "scip", fileId, line: 3, runId,
      });

      const flow = endpointFlow(store, "svc", "POST", "/p");
      const tree = flow.chain[0]!.tree!;
      const aNode = tree.children[0]!;
      const bNode = aNode.children[0]!;

      assert.equal(aNode.edge, "inferred");
      assert.equal(aNode.pathConfidence, "inferred");
      assert.equal(bNode.edge, "certain", "the edge itself is still certain");
      assert.equal(bNode.pathConfidence, "inferred", "but the PATH is not");
      assert.ok(repoId > 0);
    } finally { store.close(); }
  });
});

describe("boundary, depth and cycles (R35)", () => {
  test("expansion stops at a non-symbol node, by kind", () => {
    const store = new FactStore(join(dir, "boundary.db"));
    try {
      const { runId, fileId, route, node } = seed(store);
      const h = node("symbol", SYM("handler"));
      const pkg = node("external", "npm:axios@1.7.2");
      const table = node("datastore", "postgres://?/users");

      store.insertChainEntry({
        routeNodeId: route, position: 0, phase: "handler", origin: "route",
        symbolNodeId: h, confidence: "certain", evidenceKind: "boot", fileId, line: 1, runId,
      });
      for (const [dst, type] of [[pkg, "CALLS_EXTERNAL"], [table, "WRITES"]] as const) {
        store.insertEdge({
          srcNodeId: h, dstNodeId: dst, type, confidence: "inferred",
          evidenceKind: "scip", fileId, line: 2, runId,
        });
      }
      // An edge OUT of the boundary would be followed if kind were not the rule.
      store.insertEdge({
        srcNodeId: pkg, dstNodeId: table, type: "WRITES", confidence: "inferred",
        evidenceKind: "scip", fileId, line: 9, runId,
      });

      const tree = endpointFlow(store, "svc", "POST", "/p").chain[0]!.tree!;
      assert.equal(tree.children.length, 2);
      assert.ok(tree.children.every((c) => c.boundary && c.children.length === 0));
    } finally { store.close(); }
  });

  test("a cycle terminates and is marked, not silently pruned", () => {
    const store = new FactStore(join(dir, "cycle.db"));
    try {
      const { runId, fileId, route, node } = seed(store);
      const a = node("symbol", SYM("a"));
      const b = node("symbol", SYM("b"));
      store.insertChainEntry({
        routeNodeId: route, position: 0, phase: "handler", origin: "route",
        symbolNodeId: a, confidence: "certain", evidenceKind: "boot", fileId, line: 1, runId,
      });
      store.insertEdge({
        srcNodeId: a, dstNodeId: b, type: "CALLS", confidence: "certain",
        evidenceKind: "scip", fileId, line: 2, runId,
      });
      store.insertEdge({
        srcNodeId: b, dstNodeId: a, type: "CALLS", confidence: "certain",
        evidenceKind: "scip", fileId, line: 3, runId,
      });

      const tree = endpointFlow(store, "svc", "POST", "/p").chain[0]!.tree!;
      // a -> b -> a, and the second `a` is not expanded again.
      const b1 = tree.children[0]!;
      const a2 = b1.children[0]!;
      assert.equal(a2.cycle, true, "marked, so 'we stopped' is distinguishable from 'nothing here'");
      assert.equal(a2.children.length, 0);
    } finally { store.close(); }
  });

  test("the depth cap marks a node that HAS unexplored children", () => {
    const store = new FactStore(join(dir, "depth.db"));
    try {
      const { runId, fileId, route, node } = seed(store);
      const ids = ["a", "b", "c", "d"].map((n) => node("symbol", SYM(n)));
      store.insertChainEntry({
        routeNodeId: route, position: 0, phase: "handler", origin: "route",
        symbolNodeId: ids[0]!, confidence: "certain", evidenceKind: "boot",
        fileId, line: 1, runId,
      });
      for (let i = 0; i < ids.length - 1; i += 1) {
        store.insertEdge({
          srcNodeId: ids[i]!, dstNodeId: ids[i + 1]!, type: "CALLS",
          confidence: "certain", evidenceKind: "scip", fileId, line: i + 2, runId,
        });
      }

      const tree = endpointFlow(store, "svc", "POST", "/p", { maxDepth: 2 }).chain[0]!.tree!;
      const leaf = tree.children[0]!.children[0]!;
      assert.equal(leaf.depth, 2);
      assert.equal(leaf.truncated, true, "stopped at the cap, and says so");
      assert.equal(leaf.children.length, 0);
    } finally { store.close(); }
  });
});

describe("regressions the corpus found", () => {
  test("two call sites to one callee are two children, each keeping its own subtree", () => {
    // The path key was `<dst>/`, so two edges between the same pair collided:
    // both were pushed as children while the map kept only the last, and the
    // grandchildren attached to one arbitrary duplicate. On the corpus this
    // rendered `envelopeError` with three identical `nowIso` children, two of
    // them empty (review, 2026-09-07).
    const store = new FactStore(join(dir, "dup.db"));
    try {
      const { runId, fileId, route, node } = seed(store);
      const h = node("symbol", SYM("handler"));
      const helper = node("symbol", SYM("helper"));
      const leaf = node("symbol", SYM("leaf"));

      store.insertChainEntry({
        routeNodeId: route, position: 0, phase: "handler", origin: "route",
        symbolNodeId: h, confidence: "certain", evidenceKind: "boot", fileId, line: 1, runId,
      });
      for (const line of [10, 20]) {
        store.insertEdge({
          srcNodeId: h, dstNodeId: helper, type: "CALLS", confidence: "certain",
          evidenceKind: "scip", fileId, line, runId,
        });
      }
      store.insertEdge({
        srcNodeId: helper, dstNodeId: leaf, type: "CALLS", confidence: "certain",
        evidenceKind: "scip", fileId, line: 30, runId,
      });

      const tree = endpointFlow(store, "svc", "POST", "/p").chain[0]!.tree!;
      assert.deepEqual(tree.children.map((c) => c.line), [10, 20]);
      assert.ok(
        tree.children.every((c) => c.children.length === 1),
        "each call site keeps its own subtree, rather than one taking them all",
      );
    } finally { store.close(); }
  });

  test("an anonymous hook is scoped to its own line span, not the whole module", () => {
    // M7: the join lands on the MODULE, whose range is the file, so the hook's
    // call tree became every call in it — 31 children including `listen` and
    // `process.exit`. `end_line` (migration 004) is the hook's real extent.
    const store = new FactStore(join(dir, "scope.db"));
    try {
      const { runId, fileId, route, node } = seed(store);
      const mod = node("symbol", MODULE);
      const inHook = node("symbol", SYM("insideHook"));
      const elsewhere = node("symbol", SYM("processExit"));

      store.insertChainEntry({
        routeNodeId: route, position: 0, phase: "onRequest", origin: "scope",
        symbolNodeId: mod, confidence: "certain", evidenceKind: "boot",
        fileId, line: 36, endLine: 44, key: "server.js:36:29", runId,
      });
      store.insertEdge({
        srcNodeId: mod, dstNodeId: inHook, type: "CALLS", confidence: "certain",
        evidenceKind: "scip", fileId, line: 38, runId,
      });
      store.insertEdge({
        srcNodeId: mod, dstNodeId: elsewhere, type: "CALLS", confidence: "certain",
        evidenceKind: "scip", fileId, line: 347, runId,
      });

      const tree = endpointFlow(store, "svc", "POST", "/p").chain[0]!.tree!;
      assert.deepEqual(
        tree.children.map((c) => c.line), [38],
        "only the call inside the hook's span; line 347 belongs to the module",
      );
    } finally { store.close(); }
  });

  test("an inline security check is not reported as an unjoined chain entry", () => {
    // Inline rows deliberately store a null symbol: the check is a call SITE
    // inside a handler, not a chain function. Listing them under UNKNOWN
    // manufactured a gap, which is as dishonest as hiding a real one.
    const store = new FactStore(join(dir, "unjoined.db"));
    try {
      const { runId, fileId, route } = seed(store);
      store.insertChainEntry({
        routeNodeId: route, position: 0, phase: "handler_inline", origin: "handler",
        symbolNodeId: null, name: "checkUserAuth", checkKind: "auth",
        confidence: "inferred", evidenceKind: "treesitter",
        detail: "reviewed helper checkUserAuth", fileId, line: 169, runId,
      });
      // A genuinely unjoined boot entry, for contrast.
      store.insertChainEntry({
        routeNodeId: route, position: 0, phase: "preHandler", origin: "scope",
        symbolNodeId: null, confidence: "certain", evidenceKind: "boot",
        key: "server.js:9:9", fileId, line: 9, runId,
      });

      const flow = endpointFlow(store, "svc", "POST", "/p");
      assert.deepEqual(flow.unjoined.map((c) => c.phase), ["preHandler"]);
      assert.equal(flow.chain.filter((c) => c.phase === "handler_inline").length, 1);
    } finally { store.close(); }
  });

  test("framework chain entries are never reported as gaps", () => {
    const store = new FactStore(join(dir, "framework.db"));
    try {
      const { runId, fileId, route } = seed(store);
      store.insertChainEntry({
        routeNodeId: route, position: 0, phase: "preHandler", origin: "framework",
        symbolNodeId: null, name: "CORSMiddleware", confidence: "certain",
        evidenceKind: "boot", fileId, line: 15, runId,
      });
      assert.deepEqual(endpointFlow(store, "svc", "POST", "/p").unjoined, []);
    } finally { store.close(); }
  });
});

describe("cross-service recursion", () => {
  test("a REQUESTS edge expands into the remote route's own chain", () => {
    const store = new FactStore(join(dir, "remote.db"));
    try {
      const a = seed(store, "router");
      const b = seed(store, "engine");
      const caller = a.node("symbol", "scip npm router 1 `server.js`/proxy().");
      const remoteHandler = b.node("symbol", "scip npm engine 1 `server.js`/handle().");

      store.insertChainEntry({
        routeNodeId: a.route, position: 0, phase: "handler", origin: "route",
        symbolNodeId: caller, confidence: "certain", evidenceKind: "boot",
        fileId: a.fileId, line: 1, runId: a.runId,
      });
      store.insertChainEntry({
        routeNodeId: b.route, position: 0, phase: "handler", origin: "route",
        symbolNodeId: remoteHandler, confidence: "certain", evidenceKind: "boot",
        fileId: b.fileId, line: 1, runId: b.runId,
      });
      store.insertEdge({
        srcNodeId: caller, dstNodeId: b.route, type: "REQUESTS",
        confidence: "inferred", evidenceKind: "treesitter",
        fileId: a.fileId, line: 5, runId: a.runId,
      });

      const flow = endpointFlow(store, "router", "POST", "/p");
      const hop = flow.chain[0]!.tree!.children[0]!;
      assert.equal(hop.kind, "route");
      assert.equal(hop.edge, "inferred", "cross-service is never certain (R31)");
      assert.ok(hop.remote, "the remote route's chain is expanded in place");
      assert.equal(hop.remote!.service, "engine");
      assert.equal(hop.remote!.chain.length, 1);
      assert.deepEqual(flow.visitedServices, ["router POST /p", "engine POST /p"]);
    } finally { store.close(); }
  });

  test("mutual calls terminate instead of recursing forever", () => {
    const store = new FactStore(join(dir, "mutual.db"));
    try {
      const a = seed(store, "one");
      const b = seed(store, "two");
      const ha = a.node("symbol", "scip npm one 1 `s.js`/h().");
      const hb = b.node("symbol", "scip npm two 1 `s.js`/h().");
      for (const [route, sym, fileId, runId] of [
        [a.route, ha, a.fileId, a.runId], [b.route, hb, b.fileId, b.runId],
      ] as const) {
        store.insertChainEntry({
          routeNodeId: route, position: 0, phase: "handler", origin: "route",
          symbolNodeId: sym, confidence: "certain", evidenceKind: "boot",
          fileId, line: 1, runId,
        });
      }
      store.insertEdge({
        srcNodeId: ha, dstNodeId: b.route, type: "REQUESTS", confidence: "inferred",
        evidenceKind: "treesitter", fileId: a.fileId, line: 5, runId: a.runId,
      });
      store.insertEdge({
        srcNodeId: hb, dstNodeId: a.route, type: "REQUESTS", confidence: "inferred",
        evidenceKind: "treesitter", fileId: b.fileId, line: 5, runId: b.runId,
      });

      const flow = endpointFlow(store, "one", "POST", "/p");
      const intoTwo = flow.chain[0]!.tree!.children[0]!;
      const backToOne = intoTwo.remote!.chain[0]!.tree!.children[0]!;
      assert.equal(backToOne.kind, "route");
      assert.equal(backToOne.remote, undefined, "already visited — rendered as a boundary");
    } finally { store.close(); }
  });

  test("--no-remote stops at the service boundary", () => {
    const store = new FactStore(join(dir, "noremote.db"));
    try {
      const a = seed(store, "r1");
      const b = seed(store, "e1");
      const caller = a.node("symbol", "scip npm r1 1 `s.js`/p().");
      store.insertChainEntry({
        routeNodeId: a.route, position: 0, phase: "handler", origin: "route",
        symbolNodeId: caller, confidence: "certain", evidenceKind: "boot",
        fileId: a.fileId, line: 1, runId: a.runId,
      });
      store.insertEdge({
        srcNodeId: caller, dstNodeId: b.route, type: "REQUESTS", confidence: "inferred",
        evidenceKind: "treesitter", fileId: a.fileId, line: 5, runId: a.runId,
      });

      const flow = endpointFlow(store, "r1", "POST", "/p", { followRemote: false });
      assert.equal(flow.chain[0]!.tree!.children[0]!.remote, undefined);
    } finally { store.close(); }
  });
});

describe("unknown branches (R11, R61)", () => {
  test("unresolved_calls on the path are attached, not filtered out", () => {
    // The corpus case: `return axios(axiosConfig)` is the router's only
    // outbound HTTP call and can never become a CALLS edge, because the callee
    // resolves to a package namespace. Omitting it renders `forward` as a
    // function that calls nothing.
    const store = new FactStore(join(dir, "gaps.db"));
    try {
      const { runId, fileId, route, node } = seed(store);
      const h = node("symbol", SYM("handler"));
      const fwd = node("symbol", SYM("forward"));
      store.insertChainEntry({
        routeNodeId: route, position: 0, phase: "handler", origin: "route",
        symbolNodeId: h, confidence: "certain", evidenceKind: "boot", fileId, line: 1, runId,
      });
      store.insertEdge({
        srcNodeId: h, dstNodeId: fwd, type: "CALLS", confidence: "certain",
        evidenceKind: "scip", fileId, line: 2, runId,
      });
      store.insertUnresolved({
        srcNodeId: fwd, kind: "call", targetHint: "npm axios 1.7.2",
        reason: "callee resolved to a package, not to a function",
        fileId, line: 68, runId,
      });

      const flow = endpointFlow(store, "svc", "POST", "/p");
      assert.equal(flow.unknown.length, 1);
      assert.equal(flow.unknown[0]!.srcDisplay, "forward");
      assert.equal(flow.unknown[0]!.line, 68);
    } finally { store.close(); }
  });

  test("a gap on a symbol NOT on this path is not reported", () => {
    const store = new FactStore(join(dir, "offpath.db"));
    try {
      const { runId, fileId, route, node } = seed(store);
      const h = node("symbol", SYM("handler"));
      const other = node("symbol", SYM("unrelated"));
      store.insertChainEntry({
        routeNodeId: route, position: 0, phase: "handler", origin: "route",
        symbolNodeId: h, confidence: "certain", evidenceKind: "boot", fileId, line: 1, runId,
      });
      store.insertUnresolved({
        srcNodeId: other, kind: "call", targetHint: "x", reason: "y",
        fileId, line: 99, runId,
      });
      assert.deepEqual(endpointFlow(store, "svc", "POST", "/p").unknown, []);
    } finally { store.close(); }
  });
});

describe("route lookup", () => {
  test("a missing route names what the service does have", () => {
    const store = new FactStore(join(dir, "missing.db"));
    try {
      seed(store);
      assert.throws(
        () => endpointFlow(store, "svc", "GET", "/nope"),
        (e: unknown) => {
          assert.ok(e instanceof RouteNotFound);
          assert.deepEqual(e.candidates.map((c) => `${c.method} ${c.url}`), ["POST /p"]);
          return true;
        },
      );
    } finally { store.close(); }
  });

  test("the boot chain and the inline channel are never interleaved", () => {
    const store = new FactStore(join(dir, "order.db"));
    try {
      const { runId, fileId, route } = seed(store);
      store.insertChainEntry({
        routeNodeId: route, position: 5, phase: "onResponse", origin: "scope",
        confidence: "certain", evidenceKind: "boot", fileId, line: 46, runId,
      });
      store.insertChainEntry({
        routeNodeId: route, position: 0, phase: "handler_inline", origin: "handler",
        name: "checkUserAuth", checkKind: "auth", confidence: "inferred",
        evidenceKind: "treesitter", fileId, line: 169, runId,
      });
      store.insertChainEntry({
        routeNodeId: route, position: 0, phase: "onRequest", origin: "scope",
        confidence: "certain", evidenceKind: "boot", fileId, line: 36, runId,
      });

      // Boot rows in reported order, THEN inline. Merging them would render an
      // inference in the same list as a fact (R26, R50).
      assert.deepEqual(
        endpointFlow(store, "svc", "POST", "/p").chain.map((c) => c.phase),
        ["onRequest", "onResponse", "handler_inline"],
      );
    } finally { store.close(); }
  });
});

/** Depth-first node count, for assertions about tree size. */
export function countNodes(node: FlowNode): number {
  return 1 + node.children.reduce((n, c) => n + countNodes(c), 0);
}
