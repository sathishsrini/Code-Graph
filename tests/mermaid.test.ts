// Tests for the Mermaid emitter (task P2-T6, R46 / R50).
//
// The properties that matter are not "it produces Mermaid" — they are that the
// two visual axes stay separate, and that a diagram never draws something the
// data does not support.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactStore } from "../src/store/db.ts";
import { endpointFlow } from "../src/query/endpoint-flow.ts";
import { flowToMermaid } from "../src/serializers/mermaid.ts";

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), "code-intel-mmd-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

interface Ctx {
  store: FactStore; repoId: number; runId: number; fileId: number;
  sym: (n: string, kind?: string) => number;
  route: (m: string, u: string) => number;
}

function ctx(store: FactStore, svc = "svc"): Ctx {
  const repoId = store.upsertRepo(svc, `/tmp/${svc}`, svc);
  const runId = store.startRun(repoId, "static", "t", "");
  const fileId = store.upsertFile(repoId, "s.js", "js", `h${svc}`, runId);
  const sym = (n: string, kind = "method") => {
    const key = n.endsWith("/") ? `scip npm ${svc} 1 \`s.js\`/` : `scip npm ${svc} 1 \`s.js\`/${n}().`;
    const id = store.upsertNode("symbol", key, repoId);
    store.upsertSymbol({
      nodeId: id, fileId, displayName: n, symbolKind: kind, startLine: 1, endLine: 50,
    });
    return id;
  };
  const route = (m: string, u: string) => {
    const id = store.upsertNode("route", `${svc} ${m} ${u}`, repoId);
    store.upsertRoute({
      nodeId: id, repoId, serviceName: svc, method: m, url: u, source: "boot", runId,
    });
    return id;
  };
  return { store, repoId, runId, fileId, sym, route };
}

function arrows(text: string): string[] {
  return text.split("\n").filter((l) => /^\s+n\d+\s+(-->|-\.->|==>)\s+n\d+$/.test(l.trimEnd()))
    .map((l) => l.trim());
}

describe("the two axes stay separate (R50, R78)", () => {
  test("boot and inline checks get different classes, not different shades", () => {
    const store = new FactStore(join(dir, "axes.db"));
    try {
      const c = ctx(store);
      const route = c.route("POST", "/p");
      store.insertChainEntry({
        routeNodeId: route, position: 0, phase: "preHandler", origin: "scope",
        name: "requireAuth", checkKind: "auth", confidence: "certain",
        evidenceKind: "boot", fileId: c.fileId, line: 5, runId: c.runId,
      });
      store.insertChainEntry({
        routeNodeId: route, position: 0, phase: "handler_inline", origin: "handler",
        name: "checkUserAuth", checkKind: "auth", confidence: "inferred",
        evidenceKind: "treesitter", fileId: c.fileId, line: 9, runId: c.runId,
      });

      const mmd = flowToMermaid(endpointFlow(store, "svc", "POST", "/p"));
      assert.ok(mmd.includes("class n1 bootCheck"), "the framework-reported hook");
      assert.ok(/class n\d+ inlineCheck/.test(mmd), "the statically-inferred check");
      assert.ok(
        mmd.includes("classDef inlineCheck") && mmd.includes("stroke-dasharray"),
        "outlined, not filled — distinguishable at a glance",
      );
    } finally { store.close(); }
  });

  test("confidence is the LINK style, independent of node class", () => {
    const store = new FactStore(join(dir, "linkstyle.db"));
    try {
      const c = ctx(store);
      const route = c.route("GET", "/x");
      const handler = c.sym("handler");
      const certain = c.sym("sure");
      const inferred = c.sym("guess");
      store.insertChainEntry({
        routeNodeId: route, position: 0, phase: "handler", origin: "route",
        symbolNodeId: handler, confidence: "certain", evidenceKind: "boot",
        fileId: c.fileId, line: 1, runId: c.runId,
      });
      for (const [dst, conf, line] of [
        [certain, "certain", 2], [inferred, "inferred", 3],
      ] as const) {
        store.insertEdge({
          srcNodeId: handler, dstNodeId: dst, type: "CALLS", confidence: conf,
          evidenceKind: "scip", fileId: c.fileId, line, runId: c.runId,
        });
      }

      const mmd = flowToMermaid(endpointFlow(store, "svc", "GET", "/x"));
      assert.ok(arrows(mmd).some((a) => a.includes("-->")), "solid for certain");
      assert.ok(arrows(mmd).some((a) => a.includes("-.->")), "dashed for inferred");
    } finally { store.close(); }
  });

  test("the legend explains both axes", () => {
    const store = new FactStore(join(dir, "legend.db"));
    try {
      ctx(store).route("GET", "/x");
      const mmd = flowToMermaid(endpointFlow(store, "svc", "GET", "/x"));
      assert.ok(mmd.includes("solid = certain"));
      assert.ok(mmd.includes("boot-verified check"));
      assert.equal(flowToMermaid(endpointFlow(store, "svc", "GET", "/x"), { legend: false })
        .includes("subgraph legend"), false);
    } finally { store.close(); }
  });
});

describe("the diagram never draws what the data does not support", () => {
  test("no self-loop where a REQUESTS edge lands on the remote route", () => {
    // The edge already points AT the remote route node, so declaring the
    // remote separately returns the same id and the link would be n -.-> n.
    const store = new FactStore(join(dir, "selfloop.db"));
    try {
      const a = ctx(store, "router");
      const b = ctx(store, "engine");
      const caller = a.sym("proxy");
      const remoteHandler = b.sym("handle");
      const localRoute = a.route("POST", "/p");
      const remoteRoute = b.route("POST", "/q");
      for (const [route, sym, c] of [
        [localRoute, caller, a], [remoteRoute, remoteHandler, b],
      ] as const) {
        store.insertChainEntry({
          routeNodeId: route, position: 0, phase: "handler", origin: "route",
          symbolNodeId: sym, confidence: "certain", evidenceKind: "boot",
          fileId: c.fileId, line: 1, runId: c.runId,
        });
      }
      store.insertEdge({
        srcNodeId: caller, dstNodeId: remoteRoute, type: "REQUESTS",
        confidence: "inferred", evidenceKind: "treesitter",
        fileId: a.fileId, line: 5, runId: a.runId,
      });

      const mmd = flowToMermaid(endpointFlow(store, "router", "POST", "/p"));
      for (const arrow of arrows(mmd)) {
        const [from, , to] = arrow.split(/\s+/);
        assert.notEqual(from, to, `self-loop: ${arrow}`);
      }
    } finally { store.close(); }
  });

  test("two call sites to one callee are one arrow", () => {
    const store = new FactStore(join(dir, "dupes.db"));
    try {
      const c = ctx(store);
      const route = c.route("GET", "/x");
      const handler = c.sym("handler");
      const helper = c.sym("helper");
      store.insertChainEntry({
        routeNodeId: route, position: 0, phase: "handler", origin: "route",
        symbolNodeId: handler, confidence: "certain", evidenceKind: "boot",
        fileId: c.fileId, line: 1, runId: c.runId,
      });
      for (const line of [10, 20]) {
        store.insertEdge({
          srcNodeId: handler, dstNodeId: helper, type: "CALLS", confidence: "certain",
          evidenceKind: "scip", fileId: c.fileId, line, runId: c.runId,
        });
      }

      const all = arrows(flowToMermaid(endpointFlow(store, "svc", "GET", "/x")));
      assert.equal(new Set(all).size, all.length, "no duplicate arrows");
    } finally { store.close(); }
  });

  test("a gap node is never orphaned, and a module gap attaches to the route", () => {
    // Several anonymous hooks join one module symbol, so attaching a
    // module-scope gap to "whichever step was last" is an arbitrary edge.
    const store = new FactStore(join(dir, "gaps.db"));
    try {
      const c = ctx(store);
      const route = c.route("GET", "/x");
      const mod = c.sym("mod/", "namespace");
      store.insertChainEntry({
        routeNodeId: route, position: 0, phase: "onRequest", origin: "scope",
        symbolNodeId: mod, confidence: "certain", evidenceKind: "boot",
        fileId: c.fileId, line: 1, endLine: 9, runId: c.runId,
      });
      store.insertUnresolved({
        srcNodeId: mod, kind: "call", targetHint: "scip-typescript npm axios 1.7.2 x/",
        reason: "package", fileId: c.fileId, line: 14, runId: c.runId,
      });

      const mmd = flowToMermaid(endpointFlow(store, "svc", "GET", "/x"));
      const gapId = /^\s+(n\d+)\(\("\?\? axios@1\.7\.2"\)\)/m.exec(mmd)?.[1];
      assert.ok(gapId, "the target hint is shortened, not a raw SCIP symbol");
      assert.ok(
        arrows(mmd).some((a) => a.startsWith(`n0 `) && a.endsWith(gapId)),
        "attached to the route (n0), where a file-level gap belongs",
      );
    } finally { store.close(); }
  });

  test("boundary nodes are omitted by default and included on request", () => {
    const store = new FactStore(join(dir, "ext.db"));
    try {
      const c = ctx(store);
      const route = c.route("GET", "/x");
      const handler = c.sym("handler");
      store.insertChainEntry({
        routeNodeId: route, position: 0, phase: "handler", origin: "route",
        symbolNodeId: handler, confidence: "certain", evidenceKind: "boot",
        fileId: c.fileId, line: 1, runId: c.runId,
      });
      store.insertEdge({
        srcNodeId: handler,
        dstNodeId: store.upsertNode("external", "builtin:ecmascript", null),
        type: "CALLS_EXTERNAL", confidence: "inferred", evidenceKind: "scip",
        fileId: c.fileId, line: 2, runId: c.runId,
      });

      const flow = endpointFlow(store, "svc", "GET", "/x");
      assert.equal(flowToMermaid(flow).includes("builtin:ecmascript"), false);
      assert.ok(flowToMermaid(flow, { externals: true }).includes("builtin:ecmascript"));
    } finally { store.close(); }
  });

  test("a node cap truncates and says so", () => {
    const store = new FactStore(join(dir, "cap.db"));
    try {
      const c = ctx(store);
      const route = c.route("GET", "/x");
      const handler = c.sym("handler");
      store.insertChainEntry({
        routeNodeId: route, position: 0, phase: "handler", origin: "route",
        symbolNodeId: handler, confidence: "certain", evidenceKind: "boot",
        fileId: c.fileId, line: 1, runId: c.runId,
      });
      for (let i = 0; i < 20; i += 1) {
        store.insertEdge({
          srcNodeId: handler, dstNodeId: c.sym(`callee${i}`), type: "CALLS",
          confidence: "certain", evidenceKind: "scip", fileId: c.fileId,
          line: 10 + i, runId: c.runId,
        });
      }
      const mmd = flowToMermaid(endpointFlow(store, "svc", "GET", "/x"), { maxNodes: 6 });
      assert.ok(mmd.includes("truncated at 6 nodes"));
    } finally { store.close(); }
  });
});
