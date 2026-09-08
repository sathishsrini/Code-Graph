// Tests for the graph serializer and the UI server
// (tasks P2-T1 … P2-T5, P2-T12; R45, R49, R50, R78).
//
// The property under test throughout is the one the UI exists to obey: the two
// visual axes are two independent FIELDS in the payload. A renderer handed one
// merged "status" cannot draw "we are unsure this call happens, on a path we
// are sure succeeds" — and a viewer who cannot see that reads a dashed line as
// a failure.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactStore } from "../src/store/db.ts";
import { routeGraph, LEGEND } from "../src/serializers/graph-json.ts";
import { startUi } from "../src/ui/server.ts";

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), "code-intel-ui-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

interface Ctx {
  store: FactStore; repoId: number; runId: number; fileId: number;
  route: number; handler: number;
  sym: (n: string) => number;
}

function ctx(store: FactStore, svc = "svc"): Ctx {
  const repoId = store.upsertRepo(svc, `/tmp/${svc}`, svc);
  const runId = store.startRun(repoId, "static", "t", "");
  const fileId = store.upsertFile(repoId, "s.js", "js", `h${svc}`, runId);
  const sym = (n: string) => {
    const id = store.upsertNode("symbol", `scip npm ${svc} 1 \`s.js\`/${n}().`, repoId);
    store.upsertSymbol({
      nodeId: id, fileId, displayName: n, symbolKind: "method",
      startLine: 1, endLine: 50,
    });
    return id;
  };
  const handler = sym("handler");
  const route = store.upsertNode("route", `${svc} POST /p`, repoId);
  store.upsertRoute({
    nodeId: route, repoId, serviceName: svc, method: "POST", url: "/p",
    source: "boot", runId,
  });
  store.insertChainEntry({
    routeNodeId: route, position: 0, phase: "handler", origin: "route",
    symbolNodeId: handler, name: "handler", confidence: "certain",
    evidenceKind: "boot", key: "s.js:1:0", fileId, line: 1, runId,
  });
  return { store, repoId, runId, fileId, route, handler, sym };
}

describe("R78 — the two axes are two fields", () => {
  test("confidence and outcome are carried separately, never merged", () => {
    const store = new FactStore(join(dir, "axes.db"));
    try {
      const c = ctx(store);
      const helper = c.sym("helper");
      store.insertEdge({
        srcNodeId: c.handler, dstNodeId: helper, type: "CALLS", confidence: "inferred",
        evidenceKind: "scip", fileId: c.fileId, line: 5, runId: c.runId,
      });
      // A function whose every exit errors, reached by an INFERRED edge:
      // dashed line, red node. One merged status could not express it.
      store.replaceCfg(helper, [
        {
          symbolNodeId: helper, blockIndex: 0, parentIndex: null, kind: "root",
          startLine: 1, endLine: 50, fileId: c.fileId, runId: c.runId,
        },
        {
          symbolNodeId: helper, blockIndex: 1, parentIndex: 0, kind: "exit",
          outcome: "error_exit", exitForm: "return_error", errorName: "E-1",
          startLine: 10, endLine: 10, fileId: c.fileId, runId: c.runId,
        },
      ]);

      const g = routeGraph(store, "svc", "POST", "/p");
      const edge = g.edges.find((e) => e.type === "CALLS")!;
      assert.equal(edge.confidence, "inferred", "axis 1 lives on the edge");

      const cfg = g.cfg[`scip npm svc 1 \`s.js\`/helper().`];
      assert.ok(cfg, "axis 2 travels as control flow, not as an edge property");
      assert.equal(cfg.blocks.find((b) => b.kind === "exit")?.outcome, "error_exit");
    } finally { store.close(); }
  });

  test("the legend ships in the payload, so it cannot be forgotten", () => {
    // A viewer told separately what dashed means is a viewer where someone
    // eventually reads dashed as broken.
    const store = new FactStore(join(dir, "legend.db"));
    try {
      ctx(store);
      const g = routeGraph(store, "svc", "POST", "/p");
      assert.ok(g.legend.confidence.axis.includes("EXISTS"));
      assert.ok(g.legend.outcome.axis.includes("SUCCEEDS"));
      assert.ok(g.legend.outcome.unknown.includes("NOT the same as success"));
      assert.deepEqual(g.legend, LEGEND);
    } finally { store.close(); }
  });

  test("pathConfidence is carried beside edge confidence, not instead of it", () => {
    const store = new FactStore(join(dir, "path.db"));
    try {
      const c = ctx(store);
      const a = c.sym("a"), b = c.sym("b");
      store.insertEdge({
        srcNodeId: c.handler, dstNodeId: a, type: "CALLS", confidence: "inferred",
        evidenceKind: "scip", fileId: c.fileId, line: 5, runId: c.runId,
      });
      store.insertEdge({
        srcNodeId: a, dstNodeId: b, type: "CALLS", confidence: "certain",
        evidenceKind: "scip", fileId: c.fileId, line: 6, runId: c.runId,
      });
      const g = routeGraph(store, "svc", "POST", "/p");
      const deep = g.edges.find((e) => e.target.includes("/b()."))!;
      assert.equal(deep.confidence, "certain", "the edge itself");
      assert.equal(deep.pathConfidence, "inferred", "but the path is not (R36)");
    } finally { store.close(); }
  });
});

describe("R50 — security provenance is its own field", () => {
  test("a check carries both its kind and the channel that found it", () => {
    const store = new FactStore(join(dir, "sec.db"));
    try {
      const c = ctx(store);
      store.insertChainEntry({
        routeNodeId: c.route, position: 0, phase: "handler_inline", origin: "handler",
        name: "checkUserAuth", checkKind: "auth", confidence: "inferred",
        evidenceKind: "treesitter", detail: "reviewed helper checkUserAuth",
        fileId: c.fileId, line: 9, runId: c.runId,
      });
      const g = routeGraph(store, "svc", "POST", "/p");
      const check = g.nodes.find((n) => n.kind === "check")!;
      assert.equal(check.chain?.checkKind, "auth");
      assert.equal(check.chain?.channel, "inline", "a tick for both would be a lie");
      assert.equal(check.chain?.confidence, "inferred");
      assert.equal(check.chain?.detail, "reviewed helper checkUserAuth");
    } finally { store.close(); }
  });

  test("a boot hook and an inline check are distinguishable in the payload", () => {
    const store = new FactStore(join(dir, "channels.db"));
    try {
      const c = ctx(store);
      store.insertChainEntry({
        routeNodeId: c.route, position: 1, phase: "preHandler", origin: "scope",
        name: "requireAuth", checkKind: "auth", confidence: "certain",
        evidenceKind: "boot", fileId: c.fileId, line: 3, runId: c.runId,
      });
      store.insertChainEntry({
        routeNodeId: c.route, position: 0, phase: "handler_inline", origin: "handler",
        name: "checkUserAuth", checkKind: "auth", confidence: "inferred",
        evidenceKind: "treesitter", fileId: c.fileId, line: 9, runId: c.runId,
      });
      const g = routeGraph(store, "svc", "POST", "/p");
      const channels = g.nodes
        .filter((n) => n.chain?.checkKind === "auth")
        .map((n) => n.chain!.channel)
        .sort();
      assert.deepEqual(channels, ["boot", "inline"]);
    } finally { store.close(); }
  });
});

describe("P2-T5 — service swim-lanes", () => {
  test("a remote route belongs to ITS service, not the caller's", () => {
    const store = new FactStore(join(dir, "lanes.db"));
    try {
      const a = ctx(store, "router");
      const b = ctx(store, "engine");
      store.insertEdge({
        srcNodeId: a.handler, dstNodeId: b.route, type: "REQUESTS",
        confidence: "inferred", evidenceKind: "treesitter",
        fileId: a.fileId, line: 5, runId: a.runId,
      });
      const g = routeGraph(store, "router", "POST", "/p");
      const remote = g.nodes.find((n) => n.kind === "route" && n.key.startsWith("engine"))!;
      assert.equal(remote.service, "engine", "otherwise it lands in the wrong lane");
      assert.deepEqual(g.services.sort(), ["engine", "router"]);
    } finally { store.close(); }
  });
});

describe("R61 — gaps are a panel, not an absence", () => {
  test("unresolved call sites are carried in the payload", () => {
    // A graph that silently omits what it could not resolve looks complete.
    const store = new FactStore(join(dir, "gaps.db"));
    try {
      const c = ctx(store);
      store.insertUnresolved({
        srcNodeId: c.handler, kind: "call", targetHint: "npm axios",
        reason: "callee resolved to a package", fileId: c.fileId, line: 68, runId: c.runId,
      });
      const g = routeGraph(store, "svc", "POST", "/p");
      assert.equal(g.unknowns.length, 1);
      assert.equal(g.unknowns[0]!.where, "s.js:68");
      assert.match(g.unknowns[0]!.reason, /package/);
    } finally { store.close(); }
  });
});

describe("the server", () => {
  test("serves the viewer, elkjs, and the route list", async () => {
    const store = new FactStore(join(dir, "server.db"));
    ctx(store);
    const ui = await startUi(store, { port: 0 });
    try {
      const base = `http://127.0.0.1:${ui.port}`;

      const page = await fetch(`${base}/`);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.ok(html.includes("<svg"), "the viewer");
      assert.ok(html.includes("/elk.js"), "layout is loaded from this server, not a CDN");

      const elk = await fetch(`${base}/elk.js`);
      assert.equal(elk.status, 200);
      assert.ok((await elk.text()).length > 1000, "elkjs is served from node_modules");

      const routes = await (await fetch(`${base}/api/routes`)).json() as Array<{
        service: string; method: string; url: string;
      }>;
      assert.deepEqual(routes.map((r) => `${r.method} ${r.url}`), ["POST /p"]);
    } finally {
      await ui.close();
      store.close();
    }
  });

  test("a missing route is a 404 that names the alternatives", async () => {
    const store = new FactStore(join(dir, "server-404.db"));
    ctx(store);
    const ui = await startUi(store, { port: 0 });
    try {
      const res = await fetch(
        `http://127.0.0.1:${ui.port}/api/graph?service=svc&method=GET&path=/nope`,
      );
      assert.equal(res.status, 404);
      const body = await res.json() as { candidates: unknown[] };
      assert.ok(Array.isArray(body.candidates) && body.candidates.length > 0);
    } finally {
      await ui.close();
      store.close();
    }
  });

  test("the route list carries check kinds and channels for the picker", async () => {
    const store = new FactStore(join(dir, "server-checks.db"));
    const c = ctx(store);
    store.insertChainEntry({
      routeNodeId: c.route, position: 0, phase: "handler_inline", origin: "handler",
      name: "checkUserAuth", checkKind: "auth", confidence: "inferred",
      evidenceKind: "treesitter", fileId: c.fileId, line: 9, runId: c.runId,
    });
    const ui = await startUi(store, { port: 0 });
    try {
      const routes = await (await fetch(
        `http://127.0.0.1:${ui.port}/api/routes`,
      )).json() as Array<{ checks: Array<{ kind: string; channel: string }>; hasInline: boolean }>;
      assert.deepEqual(routes[0]!.checks, [{ kind: "auth", channel: "inline" }]);
      assert.equal(routes[0]!.hasInline, true);
    } finally {
      await ui.close();
      store.close();
    }
  });
});
