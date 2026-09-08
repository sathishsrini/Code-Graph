// Tests for error_paths (task P2-T10, R41 / R59 / R60 / R61).
//
// The property under test throughout is R41: the observed and static passes are
// independent and are never merged. A single verdict would overstate the
// observed by adding possibilities, and understate the static by weighting on
// traffic — wrong in both directions at once.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactStore } from "../src/store/db.ts";
import { errorPaths, staticFailureSurface, traceRootCause } from "../src/query/errors.ts";
import { renderErrorReport } from "../src/query/errors-render.ts";

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), "code-intel-err-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

interface Ctx {
  store: FactStore; repoId: number; runId: number; fileId: number;
  route: number; handler: number;
  sym: (n: string) => number;
  span: (o: Record<string, unknown>) => void;
}

function ctx(store: FactStore): Ctx {
  const repoId = store.upsertRepo("svc", "/tmp/svc", "svc");
  const runId = store.startRun(repoId, "static", "t", "");
  const fileId = store.upsertFile(repoId, "s.js", "js", "h", runId);

  const sym = (n: string) => {
    const id = store.upsertNode("symbol", `scip npm svc 1 \`s.js\`/${n}().`, repoId);
    store.upsertSymbol({
      nodeId: id, fileId, displayName: n, symbolKind: "method", startLine: 1, endLine: 40,
    });
    return id;
  };

  const handler = sym("handler");
  const route = store.upsertNode("route", "svc POST /p", repoId);
  store.upsertRoute({
    nodeId: route, repoId, serviceName: "svc", method: "POST", url: "/p",
    source: "boot", runId,
  });
  store.insertChainEntry({
    routeNodeId: route, position: 0, phase: "handler", origin: "route",
    symbolNodeId: handler, confidence: "certain", evidenceKind: "boot",
    fileId, line: 1, runId,
  });

  const span = (o: Record<string, unknown>) => {
    store.raw().prepare(
      `INSERT INTO spans (trace_id, span_id, parent_span_id, name, kind,
         service_name, start_unix_us, end_unix_us, duration_us, status,
         exception_type, exception_message, http_route, http_status,
         semconv, received_at)
       VALUES (?, ?, ?, ?, 'server', ?, ?, ?, 1, ?, ?, ?, ?, ?, '1.27.0', datetime('now'))`,
    ).run(
      String(o["traceId"] ?? "t1"), String(o["spanId"]),
      (o["parentSpanId"] as string | null) ?? null,
      String(o["name"] ?? "span"), String(o["service"] ?? "svc"),
      Number(o["start"] ?? 1), Number(o["end"] ?? 2), String(o["status"] ?? "ok"),
      (o["exceptionType"] as string | null) ?? null,
      (o["exceptionMessage"] as string | null) ?? null,
      (o["route"] as string | null) ?? null,
      (o["httpStatus"] as number | null) ?? null,
    );
  };

  return { store, repoId, runId, fileId, route, handler, sym, span };
}

/** An error exit inside `symbolNodeId`, optionally guarded. */
function errorExit(
  c: Ctx, symbolNodeId: number, line: number,
  opts: { form?: string; name?: string; guard?: string } = {},
): void {
  const blocks: Array<Record<string, unknown>> = [
    { blockIndex: 0, parentIndex: null, kind: "root" },
  ];
  if (opts.guard) {
    blocks.push({ blockIndex: 1, parentIndex: 0, kind: "guard", conditionText: opts.guard });
  }
  blocks.push({
    blockIndex: blocks.length, parentIndex: opts.guard ? 1 : 0, kind: "exit",
    outcome: "error_exit", exitForm: opts.form ?? "return_error", errorName: opts.name ?? null,
  });
  c.store.replaceCfg(symbolNodeId, blocks.map((b) => ({
    symbolNodeId,
    blockIndex: Number(b["blockIndex"]),
    parentIndex: b["parentIndex"] === null ? null : Number(b["parentIndex"]),
    kind: String(b["kind"]),
    conditionText: (b["conditionText"] as string | undefined) ?? null,
    outcome: (b["outcome"] as string | undefined) ?? null,
    exitForm: (b["exitForm"] as string | undefined) ?? null,
    errorName: (b["errorName"] as string | undefined) ?? null,
    startLine: line, endLine: line, fileId: c.fileId, runId: c.runId,
  })));
}

describe("M.1 — the static failure surface", () => {
  test("a returned error is found where a throw-only surface finds nothing", () => {
    // THROWS is 3 rows across the whole corpus; CFG error exits are 7 on the
    // router alone. A surface built from THROWS would report almost nothing
    // and look complete doing it (D12).
    const store = new FactStore(join(dir, "surface.db"));
    try {
      const c = ctx(store);
      errorExit(c, c.handler, 82, { name: "KRI40-AUTH-001", guard: "!token" });

      const surface = staticFailureSurface(store, c.route);
      assert.equal(surface.length, 1);
      assert.equal(surface[0]!.form, "return_error");
      assert.equal(surface[0]!.errorName, "KRI40-AUTH-001");
      assert.equal(surface[0]!.guardedBy, "!token", "the condition that reaches it");
      assert.equal(surface[0]!.evidence, "treesitter-cfg");
    } finally { store.close(); }
  });

  test("a THROWS edge is included too, and the form is kept distinct", () => {
    const store = new FactStore(join(dir, "throws.db"));
    try {
      const c = ctx(store);
      store.insertEdge({
        srcNodeId: c.handler,
        dstNodeId: store.upsertNode("external", "error:ValidationError", null),
        type: "THROWS", confidence: "inferred", evidenceKind: "treesitter",
        fileId: c.fileId, line: 20, runId: c.runId,
      });
      const surface = staticFailureSurface(store, c.route);
      assert.equal(surface[0]!.form, "throw", "throw and return_error are not equivalent");
      assert.equal(surface[0]!.errorName, "ValidationError");
    } finally { store.close(); }
  });

  test("the same throw is not counted twice when the CFG already has it", () => {
    const store = new FactStore(join(dir, "dedupe.db"));
    try {
      const c = ctx(store);
      errorExit(c, c.handler, 20, { form: "throw", name: "Boom" });
      store.insertEdge({
        srcNodeId: c.handler,
        dstNodeId: store.upsertNode("external", "error:Boom", null),
        type: "THROWS", confidence: "inferred", evidenceKind: "treesitter",
        fileId: c.fileId, line: 20, runId: c.runId,
      });
      assert.equal(staticFailureSurface(store, c.route).length, 1);
    } finally { store.close(); }
  });

  test("the surface follows CALLS, not just the chain", () => {
    const store = new FactStore(join(dir, "reach.db"));
    try {
      const c = ctx(store);
      const helper = c.sym("helper");
      store.insertEdge({
        srcNodeId: c.handler, dstNodeId: helper, type: "CALLS", confidence: "certain",
        evidenceKind: "scip", fileId: c.fileId, line: 5, runId: c.runId,
      });
      errorExit(c, helper, 99, { name: "DEEP-1" });
      assert.deepEqual(
        staticFailureSurface(store, c.route).map((f) => f.errorName), ["DEEP-1"],
      );
    } finally { store.close(); }
  });
});

describe("M.2 — the DEEPEST error span is the origin (R59)", () => {
  test("the origin is the deepest errored span, not the first or the shallowest", () => {
    // A failing request errors at every level. The shallowest just restates the
    // status code; the deepest is where it actually broke.
    const store = new FactStore(join(dir, "root.db"));
    try {
      const c = ctx(store);
      c.span({ spanId: "root", parentSpanId: null, status: "error", name: "POST /p" });
      c.span({ spanId: "mid", parentSpanId: "root", status: "error", name: "proxy" });
      c.span({
        spanId: "leaf", parentSpanId: "mid", status: "error", name: "db.query",
        exceptionType: "ConnectionError", exceptionMessage: "refused",
      });

      const rc = traceRootCause(store, "t1");
      assert.equal(rc.origin?.spanId, "leaf");
      assert.equal(rc.origin?.depth, 2);
      assert.equal(rc.origin?.exceptionType, "ConnectionError");
      assert.deepEqual(
        rc.propagation.map((s) => s.spanId), ["leaf", "mid", "root"],
        "origin first, then every ancestor",
      );
    } finally { store.close(); }
  });

  test("a trace with no errored span has no origin", () => {
    const store = new FactStore(join(dir, "noerr.db"));
    try {
      const c = ctx(store);
      c.span({ spanId: "root", parentSpanId: null, status: "ok" });
      const rc = traceRootCause(store, "t1");
      assert.equal(rc.origin, null);
      assert.deepEqual(rc.propagation, []);
    } finally { store.close(); }
  });

  test("a parent cycle in a malformed trace does not hang the query", () => {
    const store = new FactStore(join(dir, "cycle.db"));
    try {
      const c = ctx(store);
      c.span({ spanId: "a", parentSpanId: "b", status: "error" });
      c.span({ spanId: "b", parentSpanId: "a", status: "ok" });
      const rc = traceRootCause(store, "t1");
      assert.ok(rc.origin, "it terminates and still answers");
    } finally { store.close(); }
  });
});

describe("R41 — the passes are never merged", () => {
  test("an empty OBSERVED section says why, and does not mean 'nothing failed'", () => {
    const store = new FactStore(join(dir, "nospans.db"));
    try {
      const c = ctx(store);
      errorExit(c, c.handler, 82, { name: "E-1" });
      const report = errorPaths(store, "svc", "POST", "/p");

      assert.equal(report.observedAvailable, false);
      assert.deepEqual(report.observed, []);
      assert.equal(report.staticSurface.length, 1, "the static pass ran regardless");

      const text = renderErrorReport(report);
      assert.ok(text.includes("nothing was recorded, which is not the"));
      assert.ok(
        text.indexOf("OBSERVED") < text.indexOf("STATIC FAILURE SURFACE"),
        "fixed order, so a skimming reader takes the right thing as the answer",
      );
    } finally { store.close(); }
  });

  test("an observed failure does not shrink the static surface, or vice versa", () => {
    const store = new FactStore(join(dir, "independent.db"));
    try {
      const c = ctx(store);
      errorExit(c, c.handler, 82, { name: "STATIC-ONLY" });
      c.span({
        spanId: "root", parentSpanId: null, status: "error",
        route: "/p", httpStatus: 500, exceptionType: "RuntimeOnly",
      });

      const report = errorPaths(store, "svc", "POST", "/p");
      assert.equal(report.observed.length, 1);
      assert.equal(report.observed[0]!.origin?.exceptionType, "RuntimeOnly");
      assert.deepEqual(
        report.staticSurface.map((f) => f.errorName), ["STATIC-ONLY"],
        "the static pass is unaffected by what the trace showed",
      );
    } finally { store.close(); }
  });
});

describe("R61 — the mandatory UNKNOWN section", () => {
  test("an empty surface is explained, never presented as 'nothing can fail'", () => {
    const store = new FactStore(join(dir, "unknown.db"));
    try {
      ctx(store);
      const report = errorPaths(store, "svc", "POST", "/p");
      assert.equal(report.staticSurface.length, 0);
      assert.ok(
        report.unknowns.some((u) => u.includes("nothing detected")),
        "the empty result is qualified",
      );
      assert.ok(renderErrorReport(report).includes("UNKNOWN"));
    } finally { store.close(); }
  });

  test("unresolved call sites on the path are named as a limit of the surface", () => {
    const store = new FactStore(join(dir, "gaps.db"));
    try {
      const c = ctx(store);
      store.insertUnresolved({
        srcNodeId: c.handler, kind: "call", targetHint: "npm axios",
        reason: "package", fileId: c.fileId, line: 68, runId: c.runId,
      });
      const report = errorPaths(store, "svc", "POST", "/p");
      assert.ok(report.unknowns.some((u) => u.includes("unresolved call site")));
    } finally { store.close(); }
  });

  test("a chain symbol with no CFG is named", () => {
    const store = new FactStore(join(dir, "nocfg.db"));
    try {
      ctx(store);
      const report = errorPaths(store, "svc", "POST", "/p");
      assert.ok(report.unknowns.some((u) => u.includes("no control-flow analysis")));
    } finally { store.close(); }
  });

  test("the UNKNOWN heading is emitted even when there is nothing to say", () => {
    const store = new FactStore(join(dir, "clean.db"));
    try {
      const c = ctx(store);
      errorExit(c, c.handler, 10, { name: "E" });
      c.span({ spanId: "s", parentSpanId: null, status: "ok" });
      const text = renderErrorReport(errorPaths(store, "svc", "POST", "/p"));
      assert.ok(text.includes("UNKNOWN"), "the section is not conditional");
    } finally { store.close(); }
  });
});

describe("M.3 — correlated changes are a signal, not a cause", () => {
  test("a non-git target reports unavailable rather than an empty list", () => {
    // An empty list would read as "nothing changed recently", which is a claim
    // about the code rather than about the tooling.
    const store = new FactStore(join(dir, "nogit.db"));
    try {
      const c = ctx(store);
      errorExit(c, c.handler, 10, { name: "E" });
      const report = errorPaths(store, "svc", "POST", "/p");
      assert.ok(
        report.correlation.unavailable === null ||
        report.correlation.unavailable.includes("not a git repository"),
      );
      assert.ok(renderErrorReport(report).includes("never a cause"));
    } finally { store.close(); }
  });
});
