// Tests for security_path (task P1-T14, R40 / R50).
//
// The property under test throughout is that the two channels stay
// distinguishable. A route protected only by a statically-inferred check IS
// protected — `POST /api/v1/po` is exactly that — but rendering it identically
// to a boot-verified hook converts an inference into a fact, which is the one
// thing a security view must never do.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactStore } from "../src/store/db.ts";
import { securityPath } from "../src/query/security.ts";
import { renderSecurity } from "../src/query/security-render.ts";

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), "code-intel-sec-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

interface Ctx {
  store: FactStore;
  repoId: number;
  runId: number;
  fileId: number;
  route: (method: string, url: string) => number;
  check: (route: number, kind: string, channel: "boot" | "inline", name?: string) => void;
  handler: (route: number, line: number, endLine: number) => void;
  write: (table: string, line: number) => void;
}

function ctx(store: FactStore, svc = "svc"): Ctx {
  const repoId = store.upsertRepo(svc, `/tmp/${svc}`, svc);
  const runId = store.startRun(repoId, "static", "test@0", "");
  const fileId = store.upsertFile(repoId, "server.js", "js", `h-${svc}`, runId);
  const fileNode = store.upsertNode("file", `${svc}/server.js`, repoId);

  const route = (method: string, url: string) => {
    const id = store.upsertNode("route", `${svc} ${method} ${url}`, repoId);
    store.upsertRoute({
      nodeId: id, repoId, serviceName: svc, method, url, source: "boot", runId,
    });
    return id;
  };

  let pos = 0;
  const check = (
    routeNodeId: number, kind: string, channel: "boot" | "inline", name = kind,
  ) => store.insertChainEntry({
    routeNodeId,
    position: pos++,
    phase: channel === "boot" ? "preHandler" : "handler_inline",
    origin: channel === "boot" ? "scope" : "handler",
    name, checkKind: kind,
    confidence: channel === "boot" ? "certain" : "inferred",
    evidenceKind: channel === "boot" ? "boot" : "treesitter",
    detail: channel === "inline" ? `reviewed helper ${name}` : null,
    fileId, line: 10, runId,
  });

  const handler = (routeNodeId: number, line: number, endLine: number) =>
    store.insertChainEntry({
      routeNodeId, position: 90, phase: "handler", origin: "route",
      confidence: "certain", evidenceKind: "boot",
      fileId, line, endLine, runId,
    });

  const write = (table: string, line: number) =>
    store.insertEdge({
      srcNodeId: fileNode,
      dstNodeId: store.upsertNode("datastore", `postgres://?/${table}`, null),
      type: "WRITES", confidence: "inferred", evidenceKind: "treesitter",
      fileId, line, detail: `INSERT INTO ${table}`, runId,
    });

  return { store, repoId, runId, fileId, route, check, handler, write };
}

describe("R50 — the two channels stay distinguishable", () => {
  test("coverage records WHICH channel supplied each kind", () => {
    const store = new FactStore(join(dir, "channels.db"));
    try {
      const c = ctx(store);
      const booted = c.route("GET", "/booted");
      const inlined = c.route("GET", "/inlined");
      c.check(booted, "auth", "boot");
      c.check(inlined, "auth", "inline");

      const r = securityPath(store);
      const byUrl = new Map(r.routes.map((x) => [x.url, x]));
      assert.deepEqual(byUrl.get("/booted")!.coverage["auth"], ["boot"]);
      assert.deepEqual(byUrl.get("/inlined")!.coverage["auth"], ["inline"]);
    } finally { store.close(); }
  });

  test("the matrix renders boot and inline with different glyphs", () => {
    const store = new FactStore(join(dir, "glyphs.db"));
    try {
      const c = ctx(store);
      c.check(c.route("GET", "/b"), "auth", "boot");
      c.check(c.route("GET", "/i"), "auth", "inline");

      const text = renderSecurity(securityPath(store));
      const bLine = text.split("\n").find((l) => l.includes("GET /b "))!;
      const iLine = text.split("\n").find((l) => l.includes("GET /i "))!;
      assert.ok(bLine.includes("●"), "boot-verified");
      assert.ok(iLine.includes("○") && !iLine.includes("●"), "inferred, and not shown as certain");
    } finally { store.close(); }
  });

  test("a route with both channels shows both, not just the stronger", () => {
    const store = new FactStore(join(dir, "both.db"));
    try {
      const c = ctx(store);
      const r = c.route("POST", "/x");
      c.check(r, "auth", "boot");
      c.check(r, "auth", "inline");
      const report = securityPath(store);
      assert.deepEqual(report.routes[0]!.coverage["auth"], ["boot", "inline"]);
    } finally { store.close(); }
  });
});

describe("R40 — the anomaly query", () => {
  test("a write with no tenant check is flagged; one with a tenant check is not", () => {
    const store = new FactStore(join(dir, "anomaly.db"));
    try {
      const c = ctx(store);
      const bare = c.route("POST", "/bare");
      c.handler(bare, 100, 150);
      const scoped = c.route("POST", "/scoped");
      c.handler(scoped, 200, 250);
      c.check(scoped, "tenant", "boot");
      c.write("orders", 120);   // inside /bare
      c.write("orders", 220);   // inside /scoped

      const r = securityPath(store);
      assert.deepEqual(r.anomalies.map((a) => a.route.url), ["/bare"]);
    } finally { store.close(); }
  });

  test("a route that writes nothing is never an anomaly, however unprotected", () => {
    const store = new FactStore(join(dir, "readonly.db"));
    try {
      const c = ctx(store);
      const ro = c.route("GET", "/read");
      c.handler(ro, 100, 150);
      const r = securityPath(store);
      assert.deepEqual(r.anomalies, []);
      assert.deepEqual(r.unprotected.map((x) => x.url), ["/read"]);
    } finally { store.close(); }
  });

  test("the anomaly kind is a parameter, not a hard-coded 'tenant'", () => {
    const store = new FactStore(join(dir, "kind.db"));
    try {
      const c = ctx(store);
      const r = c.route("POST", "/x");
      c.handler(r, 10, 40);
      c.check(r, "tenant", "boot");
      c.write("t", 20);
      assert.equal(securityPath(store).anomalies.length, 0);
      assert.equal(securityPath(store, { anomalyKind: "rbac" }).anomalies.length, 1);
    } finally { store.close(); }
  });

  test("a write is attributed to the handler whose body contains it", () => {
    // Unbounded, the file-scope pass gave every route in the file every table:
    // 21 of 21 routes flagged on 41-kri-engine, including GET /health, which
    // is indistinguishable from no answer. The handler's line span is already
    // stored, so the write lands on the one route that makes it.
    const store = new FactStore(join(dir, "span.db"));
    try {
      const c = ctx(store);
      const po = c.route("POST", "/po");
      const health = c.route("GET", "/health");
      c.handler(po, 200, 260);
      c.handler(health, 90, 95);
      c.write("purchase_orders", 217);

      const r = securityPath(store);
      const byUrl = new Map(r.routes.map((x) => [x.url, x]));
      assert.deepEqual(
        byUrl.get("/po")!.writes.map((w) => w.datastore), ["postgres://?/purchase_orders"],
      );
      assert.deepEqual(byUrl.get("/health")!.writes, [], "a GET route writes nothing");
    } finally { store.close(); }
  });

  test("a call-graph-reached write outranks the file-scope fallback", () => {
    const store = new FactStore(join(dir, "viacall.db"));
    try {
      const c = ctx(store);
      const route = c.route("POST", "/x");
      const handler = store.upsertNode("symbol", "scip npm svc 1 `s.js`/h().", c.repoId);
      store.upsertSymbol({
        nodeId: handler, fileId: c.fileId, displayName: "h",
        symbolKind: "method", startLine: 10, endLine: 40,
      });
      store.insertChainEntry({
        routeNodeId: route, position: 0, phase: "handler", origin: "route",
        symbolNodeId: handler, confidence: "certain", evidenceKind: "boot",
        fileId: c.fileId, line: 10, runId: c.runId,
      });
      store.insertEdge({
        srcNodeId: handler,
        dstNodeId: store.upsertNode("datastore", "postgres://?/orders", null),
        type: "WRITES", confidence: "inferred", evidenceKind: "treesitter",
        fileId: c.fileId, line: 20, runId: c.runId,
      });

      const r = securityPath(store);
      assert.equal(r.routes[0]!.writes[0]!.via, "call", "precise attribution wins");
    } finally { store.close(); }
  });
});

describe("R61 — blind spots", () => {
  test("an unjoined chain entry is reported, so 'unprotected' is qualified", () => {
    // The worst output this engine could produce is calling a route
    // unprotected when its chain has an entry nothing could resolve.
    const store = new FactStore(join(dir, "blind.db"));
    try {
      const c = ctx(store);
      const route = c.route("GET", "/x");
      store.insertChainEntry({
        routeNodeId: route, position: 0, phase: "preHandler", origin: "scope",
        symbolNodeId: null, key: "server.js:9:9", confidence: "certain",
        evidenceKind: "boot", fileId: c.fileId, line: 9, runId: c.runId,
      });

      const r = securityPath(store);
      assert.equal(r.blindSpots.length, 1);
      assert.equal(r.blindSpots[0]!.key, "server.js:9:9");
      assert.ok(renderSecurity(r).includes("BLIND SPOTS"));
    } finally { store.close(); }
  });

  test("framework entries are not blind spots", () => {
    const store = new FactStore(join(dir, "fw.db"));
    try {
      const c = ctx(store);
      const route = c.route("GET", "/x");
      store.insertChainEntry({
        routeNodeId: route, position: 0, phase: "preHandler", origin: "framework",
        symbolNodeId: null, name: "CORSMiddleware", confidence: "certain",
        evidenceKind: "boot", fileId: c.fileId, line: 15, runId: c.runId,
      });
      assert.deepEqual(securityPath(store).blindSpots, []);
    } finally { store.close(); }
  });

  test("'unprotected' is rendered with what it does and does not mean", () => {
    const store = new FactStore(join(dir, "wording.db"));
    try {
      const c = ctx(store);
      c.route("GET", "/health");
      const text = renderSecurity(securityPath(store));
      assert.ok(
        text.includes("no check this engine can see"),
        "a public health route and an undetected guard look identical here",
      );
    } finally { store.close(); }
  });
});

describe("scoping", () => {
  test("--repo limits the matrix to one service", () => {
    const store = new FactStore(join(dir, "scope-svc.db"));
    try {
      ctx(store, "a").route("GET", "/x");
      ctx(store, "b").route("GET", "/y");
      const r = securityPath(store, { service: "a" });
      assert.deepEqual(r.routes.map((x) => x.service), ["a"]);
    } finally { store.close(); }
  });

  test("the matrix keeps all four standard columns on a sparse corpus", () => {
    const store = new FactStore(join(dir, "columns.db"));
    try {
      const c = ctx(store);
      c.check(c.route("GET", "/x"), "auth", "boot");
      const r = securityPath(store);
      for (const k of ["auth", "tenant", "rbac", "ratelimit"]) {
        assert.ok(r.kinds.includes(k), `${k} column present even with no rows`);
      }
    } finally { store.close(); }
  });
});
