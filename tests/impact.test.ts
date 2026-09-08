// Tests for impact (task P1-T13, R37/R38/R39).
//
// Three of these are regressions for defects found by running the query on the
// corpus, all of which produced a CONFIDENTLY WRONG answer rather than an
// error: routes reported as affected that are not, a route counted but absent
// from every confidence bucket, and certain evidence relabelled as inferred.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactStore } from "../src/store/db.ts";
import { impact, resolveSeed, SeedNotFound } from "../src/query/impact.ts";

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), "code-intel-impact-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

const SYM = (svc: string, name: string) => `scip npm ${svc} 1 \`server.js\`/${name}().`;
const MODULE = (svc: string) => `scip npm ${svc} 1 \`server.js\`/`;

interface Ctx {
  store: FactStore;
  repoId: number;
  runId: number;
  fileId: number;
  node: (kind: Parameters<FactStore["upsertNode"]>[0], key: string) => number;
  sym: (name: string) => number;
  route: (method: string, url: string) => number;
  calls: (src: number, dst: number, line: number, conf?: "certain" | "inferred") => void;
  handles: (route: number, sym: number) => void;
}

function ctx(store: FactStore, svc = "svc"): Ctx {
  const repoId = store.upsertRepo(svc, `/tmp/${svc}`, svc);
  const runId = store.startRun(repoId, "static", "test@0", "");
  const fileId = store.upsertFile(repoId, "server.js", "js", `h-${svc}`, runId);
  const node = (kind: Parameters<FactStore["upsertNode"]>[0], key: string) =>
    store.upsertNode(kind, key, repoId);

  const sym = (name: string) => {
    const id = node("symbol", name.endsWith("/") ? name : SYM(svc, name));
    store.upsertSymbol({
      nodeId: id, fileId, displayName: name.endsWith("/") ? "server.js" : name,
      symbolKind: name.endsWith("/") ? "namespace" : "method", startLine: 1,
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
  const calls = (src: number, dst: number, line: number, conf: "certain" | "inferred" = "certain") =>
    store.insertEdge({
      srcNodeId: src, dstNodeId: dst, type: "CALLS", confidence: conf,
      evidenceKind: "scip", fileId, line, runId,
    });
  const handles = (routeId: number, symId: number) =>
    store.insertEdge({
      srcNodeId: routeId, dstNodeId: symId, type: "HANDLES", confidence: "certain",
      evidenceKind: "boot", fileId, line: 1, runId,
    });

  return { store, repoId, runId, fileId, node, sym, route, calls, handles };
}

describe("seed resolution", () => {
  test("an ambiguous name is refused, with both candidates named", () => {
    // Answering about the wrong `nowIso` with nothing in the output saying so
    // is the failure this whole project is about.
    const store = new FactStore(join(dir, "ambiguous.db"));
    try {
      ctx(store, "a").sym("nowIso");
      ctx(store, "b").sym("nowIso");
      assert.throws(() => resolveSeed(store, "nowIso"), (e: unknown) => {
        assert.ok(e instanceof SeedNotFound);
        assert.equal(e.matches.length, 2);
        assert.match(e.message, /ambiguous/);
        return true;
      });
    } finally { store.close(); }
  });

  test("a verbatim SCIP symbol resolves even when the name is ambiguous", () => {
    const store = new FactStore(join(dir, "verbatim.db"));
    try {
      ctx(store, "a").sym("nowIso");
      ctx(store, "b").sym("nowIso");
      assert.equal(resolveSeed(store, SYM("a", "nowIso")).display, "nowIso");
    } finally { store.close(); }
  });

  test("a missing seed names nothing rather than guessing", () => {
    const store = new FactStore(join(dir, "missing-seed.db"));
    try {
      ctx(store).sym("real");
      assert.throws(() => resolveSeed(store, "imaginary"), /no symbol matching/);
    } finally { store.close(); }
  });
});

describe("R37 — direct, transitive and confidence are three answers", () => {
  test("depth 1 is reported separately from the rest", () => {
    const store = new FactStore(join(dir, "depths.db"));
    try {
      const c = ctx(store);
      const [seed, near, far] = [c.sym("seed"), c.sym("near"), c.sym("far")];
      c.calls(near, seed, 10);
      c.calls(far, near, 20);

      const r = impact(store, "seed");
      assert.deepEqual(r.direct.map((s) => s.display), ["near"]);
      assert.deepEqual(r.transitive.map((s) => s.display), ["far"]);
    } finally { store.close(); }
  });

  test("one inferred hop puts the route in the INFERRED bucket, not CERTAIN", () => {
    const store = new FactStore(join(dir, "conf.db"));
    try {
      const c = ctx(store);
      const seed = c.sym("seed");
      const handler = c.sym("handler");
      c.calls(handler, seed, 10, "inferred");
      const route = c.route("GET", "/x");
      c.handles(route, handler);

      const r = impact(store, "seed");
      assert.equal(r.routes.certain.length, 0);
      assert.deepEqual(r.routes.inferred.map((x) => x.url), ["/x"]);
    } finally { store.close(); }
  });
});

describe("regressions found by running it on the corpus", () => {
  test("a module symbol does not bridge unrelated routes", () => {
    // The defect: a call inside an anonymous handler attributes to the MODULE,
    // and the module is HANDLED by every route in the file. `checkUserAuth`
    // reported /health, /ready and POST /api/v1/auth/login as affected — none
    // of which call it. A confident wrong answer (self-review, 2026-09-08).
    const store = new FactStore(join(dir, "bridge.db"));
    try {
      const c = ctx(store);
      const seed = c.sym("checkUserAuth");
      const mod = c.sym(MODULE("svc"));
      const handler = c.sym("proxyToEngine");

      c.calls(mod, seed, 292);        // the call inside an anonymous handler
      c.calls(handler, seed, 169);    // a real, named caller

      const guarded = c.route("POST", "/guarded");
      const publicRoute = c.route("GET", "/health");
      c.handles(guarded, handler);
      c.handles(guarded, mod);        // its own anonymous hook
      c.handles(publicRoute, mod);    // /health only ever reaches the module

      const r = impact(store, "checkUserAuth");
      const urls = [...r.routes.certain, ...r.routes.inferred, ...r.routes.unknown]
        .map((x) => x.url);
      assert.deepEqual(urls, ["/guarded"], "/health does not call checkUserAuth");
      assert.ok(
        r.direct.some((s) => s.display === "server.js"),
        "the module is still reported as an affected symbol — the call is real",
      );
    } finally { store.close(); }
  });

  test("route_chain recovers a route whose handler is anonymous", () => {
    // The other half of the fix above. Stopping at the module would lose the
    // route that genuinely runs the seed inside an anonymous handler; the
    // chain names it exactly, at the right route and nowhere else.
    const store = new FactStore(join(dir, "chainnamed.db"));
    try {
      const c = ctx(store);
      const seed = c.sym("checkUserAuth");
      const mod = c.sym(MODULE("svc"));
      c.calls(mod, seed, 292);
      const mail = c.route("POST", "/mail");
      const other = c.route("GET", "/health");
      c.handles(mail, mod);
      c.handles(other, mod);
      store.insertChainEntry({
        routeNodeId: mail, position: 0, phase: "handler_inline", origin: "handler",
        name: "checkUserAuth", checkKind: "auth", confidence: "inferred",
        evidenceKind: "treesitter", fileId: c.fileId, line: 292, runId: c.runId,
      });

      const r = impact(store, "checkUserAuth");
      assert.equal(r.totalRoutes, 1);
      assert.deepEqual(r.routes.inferred.map((x) => x.url), ["/mail"]);
    } finally { store.close(); }
  });

  test("every counted route lands in exactly one confidence bucket", () => {
    // The chain-named merge originally ran AFTER bucketing, so a route was
    // counted in `totalRoutes` and missing from every bucket: the sections
    // summed to one less than the total.
    const store = new FactStore(join(dir, "buckets.db"));
    try {
      const c = ctx(store);
      const seed = c.sym("seed");
      const handler = c.sym("handler");
      c.calls(handler, seed, 10);
      const viaCall = c.route("GET", "/via-call");
      c.handles(viaCall, handler);
      const viaChain = c.route("POST", "/via-chain");
      store.insertChainEntry({
        routeNodeId: viaChain, position: 0, phase: "handler_inline", origin: "handler",
        name: "seed", confidence: "inferred", evidenceKind: "treesitter",
        fileId: c.fileId, line: 5, runId: c.runId,
      });

      const r = impact(store, "seed");
      const sum = r.routes.certain.length + r.routes.inferred.length + r.routes.unknown.length;
      assert.equal(sum, r.totalRoutes);
      assert.equal(r.totalRoutes, 2);
    } finally { store.close(); }
  });

  test("a certain call path outranks an inferred chain row for the same route", () => {
    // Ranking by depth alone relabelled 15 compiler-resolved routes as
    // inferred, because the inline row is depth 1 and the call chain depth 2.
    // Understating what is known is the mirror of overstating it.
    const store = new FactStore(join(dir, "rank.db"));
    try {
      const c = ctx(store);
      const seed = c.sym("checkUserAuth");
      const handler = c.sym("proxyToEngine");
      c.calls(handler, seed, 169);
      const route = c.route("POST", "/po");
      c.handles(route, handler);
      store.insertChainEntry({
        routeNodeId: route, position: 0, phase: "handler_inline", origin: "handler",
        name: "checkUserAuth", confidence: "inferred", evidenceKind: "treesitter",
        fileId: c.fileId, line: 169, runId: c.runId,
      });

      const r = impact(store, "checkUserAuth");
      assert.deepEqual(r.routes.certain.map((x) => x.url), ["/po"]);
      assert.equal(r.routes.inferred.length, 0);
    } finally { store.close(); }
  });
});

describe("R39 — fan-in and the utility verdict", () => {
  test("a high-fan-in symbol is flagged rather than merely listed", () => {
    const store = new FactStore(join(dir, "utility.db"));
    try {
      const c = ctx(store);
      const seed = c.sym("nowIso");
      for (let i = 0; i < 12; i += 1) c.calls(c.sym(`caller${i}`), seed, i + 1);

      const r = impact(store, "nowIso");
      assert.equal(r.fanIn, 12);
      assert.equal(r.isUtility, true);
    } finally { store.close(); }
  });

  test("the threshold is a declared option, not a hard-coded constant", () => {
    const store = new FactStore(join(dir, "threshold.db"));
    try {
      const c = ctx(store);
      const seed = c.sym("helper");
      for (let i = 0; i < 3; i += 1) c.calls(c.sym(`c${i}`), seed, i + 1);
      assert.equal(impact(store, "helper").isUtility, false);
      assert.equal(impact(store, "helper", { utilityFanIn: 3 }).isUtility, true);
    } finally { store.close(); }
  });

  test("the route LIST is trimmed and the COUNT stays exact", () => {
    const store = new FactStore(join(dir, "trim.db"));
    try {
      const c = ctx(store);
      const seed = c.sym("seed");
      const handler = c.sym("handler");
      c.calls(handler, seed, 1);
      for (let i = 0; i < 40; i += 1) c.handles(c.route("GET", `/r${i}`), handler);

      const r = impact(store, "seed", { routeLimit: 10 });
      assert.equal(r.totalRoutes, 40, "the count is not what gets cut");
      assert.equal(r.routesTruncated, true);
      const shown = r.routes.certain.length + r.routes.inferred.length + r.routes.unknown.length;
      assert.ok(shown <= 12 && shown > 0, `trimmed to ${shown}`);
    } finally { store.close(); }
  });
});

describe("R38 — dependency kinds beyond the call graph", () => {
  test("two services reading one env var are coupled through it", () => {
    const store = new FactStore(join(dir, "config-dep.db"));
    try {
      const a = ctx(store, "svc-a");
      const b = ctx(store, "svc-b");
      const cfg = store.upsertNode("config", "env:DATABASE_URL", null);
      const reader = a.sym("connect");
      const otherReader = b.sym("connect");
      for (const [src, c] of [[reader, a], [otherReader, b]] as const) {
        store.insertEdge({
          srcNodeId: src, dstNodeId: cfg, type: "READS_CONFIG", confidence: "inferred",
          evidenceKind: "treesitter", fileId: c.fileId, line: 3, runId: c.runId,
        });
      }

      const r = impact(store, SYM("svc-a", "connect"));
      assert.equal(r.configuration.length, 1);
      assert.equal(r.configuration[0]!.key, "env:DATABASE_URL");
      assert.equal(r.configuration[0]!.alsoUsedBy.length, 1);
      assert.equal(r.configuration[0]!.attributedTo, "symbol");
    } finally { store.close(); }
  });

  test("a file-attributed datastore edge is reported AND labelled file-scope", () => {
    // Every SQL literal in the corpus sits at module scope or inside an
    // anonymous handler, so it attributes to the file. Reporting it as the
    // symbol's own dependency would overstate; reporting nothing would hide a
    // real coupling. It is reported, and labelled.
    const store = new FactStore(join(dir, "data-dep.db"));
    try {
      const c = ctx(store);
      const seed = c.sym("sendMail");
      const fileNode = store.upsertNode("file", "svc/server.js", c.repoId);
      const table = store.upsertNode("datastore", "postgres://?/mail_events", null);
      store.insertEdge({
        srcNodeId: fileNode, dstNodeId: table, type: "WRITES", confidence: "inferred",
        evidenceKind: "treesitter", fileId: c.fileId, line: 143, runId: c.runId,
      });

      const r = impact(store, SYM("svc", "sendMail"));
      assert.equal(r.data.length, 1);
      assert.equal(r.data[0]!.key, "postgres://?/mail_events");
      assert.equal(r.data[0]!.attributedTo, "file", "coarser than the seed asked about");
      assert.ok(seed > 0);
    } finally { store.close(); }
  });

  test("runtime reports 'no producer', never a bare empty list", () => {
    // "No runtime evidence" and "we did not look" are different answers, and
    // only one of them is about the code.
    const store = new FactStore(join(dir, "runtime.db"));
    try {
      ctx(store).sym("seed");
      const r = impact(store, "seed");
      assert.equal(r.runtime.available, false);
      assert.match(r.runtime.reason, /P2-T8/);
    } finally { store.close(); }
  });
});

describe("cross-service", () => {
  test("a REQUESTS edge carries impact into the calling service", () => {
    const store = new FactStore(join(dir, "xservice.db"));
    try {
      const engine = ctx(store, "engine");
      const router = ctx(store, "router");
      const seed = engine.sym("createPo");
      const engineRoute = engine.route("POST", "/api/v1/po");
      engine.handles(engineRoute, seed);

      const caller = router.sym("proxyToEngine");
      store.insertEdge({
        srcNodeId: caller, dstNodeId: engineRoute, type: "REQUESTS",
        confidence: "inferred", evidenceKind: "treesitter",
        fileId: router.fileId, line: 176, runId: router.runId,
      });
      const routerRoute = router.route("POST", "/api/v1/po");
      router.handles(routerRoute, caller);

      const r = impact(store, SYM("engine", "createPo"));
      const services = new Set(
        [...r.routes.certain, ...r.routes.inferred].map((x) => x.service),
      );
      assert.ok(services.has("engine"));
      assert.ok(services.has("router"), "the caller's own route is affected too");
    } finally { store.close(); }
  });
});
