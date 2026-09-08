// Tests for the runtime channel (tasks P2-T8 / P2-T9, R53–R57).
//
// The invariant this whole area exists to protect is R56: **runtime never
// deletes a static edge.** Traces establish that a call happened; they
// establish nothing about calls that did not happen today. An engine that
// pruned unexercised paths would be wrong in the direction nobody notices
// until the code is gone.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactStore } from "../src/store/db.ts";
import {
  TailSampler, attr, insertSpans, keepByHash, normalise, SEMCONV_VERSION,
  type NormalisedSpan,
} from "../src/runtime/otlp.ts";
import { promote, countPossiblyDead } from "../src/runtime/promote.ts";
import { startReceiver } from "../src/runtime/receiver.ts";

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), "code-intel-rt-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

function otlpSpan(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    traceId: "t1", spanId: "s1", name: "GET /x", kind: 2,
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000100000000",
    status: { code: 1 },
    attributes: [],
    ...over,
  };
}

function payload(spans: Array<Record<string, unknown>>, service = "svc"): unknown {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
      scopeSpans: [{ spans }],
    }],
  };
}

const kv = (key: string, value: string | number) => ({
  key,
  value: typeof value === "number" ? { intValue: value } : { stringValue: value },
});

describe("R55 — both semconv spellings", () => {
  test("the old and new code.* names both resolve", () => {
    // A fleet mid-migration emits both at once. Reading only one spelling
    // silently drops every span from half the services.
    assert.equal(attr({ "code.function.name": "a" }, "code.function.name"), "a");
    assert.equal(attr({ "code.function": "b" }, "code.function.name"), "b");
    assert.equal(attr({ "code.file.path": "x.ts" }, "code.file.path"), "x.ts");
    assert.equal(attr({ "code.filepath": "y.ts" }, "code.file.path"), "y.ts");
  });

  test("the new spelling wins when a span carries both", () => {
    assert.equal(
      attr({ "code.function.name": "new", "code.function": "old" }, "code.function.name"),
      "new",
    );
  });

  test("http and db aliases resolve too", () => {
    assert.equal(attr({ "http.method": "POST" }, "http.request.method"), "POST");
    assert.equal(attr({ "http.status_code": 500 }, "http.response.status_code"), 500);
    assert.equal(attr({ "db.system": "postgresql" }, "db.system.name"), "postgresql");
  });

  test("every row records the semconv it was normalised against", () => {
    const [span] = normalise(payload([otlpSpan()]) as never);
    assert.equal(span?.semconv, SEMCONV_VERSION);
  });
});

describe("normalising OTLP/JSON", () => {
  test("nanoseconds are converted exactly, not through an unsafe Number", () => {
    // Number("1700000000000000000") is already wrong: 1.7e18 exceeds the safe
    // integer range, and SQLite then refuses to hand the value back at all.
    const [span] = normalise(payload([otlpSpan()]) as never);
    assert.equal(span?.startUnixUs, 1_700_000_000_000_000);
    assert.equal(span?.durationUs, 100_000);
    assert.ok(Number.isSafeInteger(span!.startUnixUs));
  });

  test("extracts the R54 join keys into columns", () => {
    const [span] = normalise(payload([otlpSpan({
      attributes: [
        kv("http.route", "/api/v1/po"), kv("http.request.method", "POST"),
        kv("http.response.status_code", 201), kv("code.function.name", "createPo"),
        kv("code.file.path", "server.js"), kv("db.system.name", "postgresql"),
        kv("server.address", "engine:3002"),
      ],
    })], "router") as never);

    assert.equal(span?.serviceName, "router");
    assert.equal(span?.httpRoute, "/api/v1/po");
    assert.equal(span?.httpMethod, "POST");
    assert.equal(span?.httpStatus, 201);
    assert.equal(span?.codeFunction, "createPo");
    assert.equal(span?.dbSystem, "postgresql");
    assert.equal(span?.serverAddress, "engine:3002");
    assert.equal(span?.kind, "server");
  });

  test("an exception event becomes the error origin", () => {
    const [span] = normalise(payload([otlpSpan({
      status: { code: 2, message: "boom" },
      events: [{
        name: "exception",
        attributes: [kv("exception.type", "TypeError"), kv("exception.message", "x is not a fn")],
      }],
    })]) as never);
    assert.equal(span?.status, "error");
    assert.equal(span?.exceptionType, "TypeError");
    assert.equal(span?.exceptionMessage, "x is not a fn");
  });

  test("a malformed span is skipped, not thrown on", () => {
    // A receiver that rejects a batch because one span lacks a trace id loses
    // 999 good spans to fix one, and the sender has already moved on.
    const spans = normalise(payload([{ name: "no ids" }, otlpSpan()]) as never);
    assert.equal(spans.length, 1);
  });

  test("the legacy instrumentationLibrarySpans envelope still parses", () => {
    const spans = normalise({
      resourceSpans: [{
        resource: { attributes: [kv("service.name", "old")] },
        instrumentationLibrarySpans: [{ spans: [otlpSpan()] }],
      }],
    } as never);
    assert.equal(spans[0]?.serviceName, "old");
  });
});

describe("R53 — tail-based sampling", () => {
  const span = (over: Partial<NormalisedSpan>): NormalisedSpan => ({
    traceId: "t", spanId: "s", parentSpanId: null, name: "n", kind: "server",
    serviceName: "svc", startUnixUs: 1, endUnixUs: 2, durationUs: 1,
    status: "ok", statusMessage: null, httpRoute: null, httpMethod: null,
    httpStatus: null, codeFunction: null, codeFilepath: null, dbSystem: null,
    dbName: null, dbOperation: null, serverAddress: null, exceptionType: null,
    exceptionMessage: null, semconv: SEMCONV_VERSION, attributes: {},
    ...over,
  });

  test("an errored trace is kept whole, whatever the rate", () => {
    // The decision cannot be per span: a trace is errored if ANY span errored,
    // and the root a head sampler would decide on usually arrives last.
    const sampler = new TailSampler({ successRate: 0 });
    const kept = sampler.add([
      span({ traceId: "e", spanId: "child", parentSpanId: "root", status: "error" }),
      span({ traceId: "e", spanId: "root", parentSpanId: null, status: "ok" }),
    ]);
    assert.equal(kept.length, 2, "the whole trace, including its non-errored spans");
  });

  test("a successful trace is dropped at rate 0 and kept at rate 1", () => {
    assert.equal(new TailSampler({ successRate: 0 })
      .add([span({ traceId: "a", parentSpanId: null })]).length, 0);
    assert.equal(new TailSampler({ successRate: 1 })
      .add([span({ traceId: "a", parentSpanId: null })]).length, 1);
  });

  test("the success sample is deterministic, so a re-run reproduces the store", () => {
    // A random draw would make the store non-reproducible, which Phase 0's
    // determinism criterion forbids.
    for (const id of ["trace-a", "trace-b", "trace-c"]) {
      assert.equal(keepByHash(id, 0.5), keepByHash(id, 0.5));
    }
    const kept = ["a", "b", "c", "d", "e", "f", "g", "h"].filter((t) => keepByHash(t, 0.5));
    assert.ok(kept.length > 0 && kept.length < 8, "the rate actually splits");
  });

  test("a trace with no root yet is held, then decided on timeout", () => {
    let now = 1000;
    const sampler = new TailSampler({ successRate: 1, completionMs: 100, now: () => now });
    assert.equal(sampler.add([span({ traceId: "t", spanId: "c", parentSpanId: "r" })]).length, 0);
    assert.equal(sampler.bufferedTraces, 1);
    now += 200;
    assert.equal(sampler.add([]).length, 1, "released once it expired");
  });

  test("flushAll decides everything buffered — nothing is dropped on shutdown", () => {
    const sampler = new TailSampler({ successRate: 1, completionMs: 1_000_000 });
    sampler.add([span({ traceId: "t", spanId: "c", parentSpanId: "r" })]);
    assert.equal(sampler.flushAll().length, 1);
    assert.equal(sampler.bufferedTraces, 0);
  });
});

describe("R56 — runtime never deletes a static edge", () => {
  function seeded(name: string) {
    const store = new FactStore(join(dir, name));
    const repoId = store.upsertRepo("router", "/tmp/router", "router");
    const engineRepo = store.upsertRepo("engine", "/tmp/engine", "engine");
    const runId = store.startRun(repoId, "static", "t", "");
    const fileId = store.upsertFile(repoId, "s.js", "js", "h", runId);

    const routerRoute = store.upsertNode("route", "router POST /p", repoId);
    const engineRoute = store.upsertNode("route", "engine POST /q", engineRepo);
    for (const [node, svc, url, repo] of [
      [routerRoute, "router", "/p", repoId], [engineRoute, "engine", "/q", engineRepo],
    ] as const) {
      store.upsertRoute({
        nodeId: node, repoId: repo, serviceName: svc, method: "POST", url,
        source: "boot", runId,
      });
    }
    return { store, repoId, runId, fileId, routerRoute, engineRoute };
  }

  test("an inferred REQUESTS edge is upgraded to observed, not replaced", () => {
    const s = seeded("promote.db");
    try {
      s.store.insertEdge({
        srcNodeId: s.routerRoute, dstNodeId: s.engineRoute, type: "REQUESTS",
        confidence: "inferred", evidenceKind: "treesitter",
        fileId: s.fileId, line: 176, runId: s.runId,
      });
      const before = s.store.countRows("edges");

      insertSpans(s.store, normalise(payload([
        otlpSpan({ spanId: "root", attributes: [kv("http.route", "/p")] }),
      ], "router") as never));
      insertSpans(s.store, normalise(payload([
        otlpSpan({
          spanId: "client", parentSpanId: "root", kind: 3,
          attributes: [kv("http.route", "/q"), kv("http.request.method", "POST"),
            kv("server.address", "engine")],
        }),
      ], "router") as never));

      const report = promote(s.store);
      assert.equal(report.promoted, 1);
      assert.equal(s.store.countRows("edges"), before, "no edge added, none removed");

      const row = s.store.raw().prepare(
        "SELECT confidence, evidence_kind FROM edges WHERE type = 'REQUESTS'",
      ).get() as { confidence: string; evidence_kind: string };
      assert.equal(row.confidence, "observed");
      assert.equal(row.evidence_kind, "treesitter", "provenance is not rewritten");
    } finally { s.store.close(); }
  });

  test("a certain edge is confirmed but never downgraded", () => {
    // The compiler resolved it. A trace agreeing adds nothing; a trace not
    // covering it removes nothing.
    const s = seeded("certain.db");
    try {
      s.store.insertEdge({
        srcNodeId: s.routerRoute, dstNodeId: s.engineRoute, type: "REQUESTS",
        confidence: "certain", evidenceKind: "scip", fileId: s.fileId, line: 1, runId: s.runId,
      });
      insertSpans(s.store, normalise(payload([
        otlpSpan({ spanId: "root", attributes: [kv("http.route", "/p")] }),
        otlpSpan({
          spanId: "client", parentSpanId: "root", kind: 3,
          attributes: [kv("http.route", "/q"), kv("http.request.method", "POST"),
            kv("server.address", "engine")],
        }),
      ], "router") as never));

      promote(s.store);
      const row = s.store.raw().prepare(
        "SELECT confidence FROM edges WHERE type = 'REQUESTS'",
      ).get() as { confidence: string };
      assert.equal(row.confidence, "certain");
    } finally { s.store.close(); }
  });

  test("promotion issues no DELETE against edges, ever", () => {
    const s = seeded("nodelete.db");
    try {
      // Several static edges no trace will touch.
      for (let i = 0; i < 5; i += 1) {
        const sym = s.store.upsertNode("symbol", `scip npm router 1 \`s.js\`/f${i}().`, s.repoId);
        s.store.insertEdge({
          srcNodeId: s.routerRoute, dstNodeId: sym, type: "HANDLES",
          confidence: "certain", evidenceKind: "boot",
          fileId: s.fileId, line: i + 1, runId: s.runId,
        });
      }
      const before = s.store.countRows("edges");
      promote(s.store);
      assert.equal(s.store.countRows("edges"), before, "nothing was pruned");
    } finally { s.store.close(); }
  });

  test("an unmatched join key is counted, not hidden", () => {
    const s = seeded("unmatched.db");
    try {
      insertSpans(s.store, normalise(payload([
        otlpSpan({ attributes: [kv("http.route", "/does-not-exist")] }),
      ], "router") as never));
      assert.equal(promote(s.store).unmatched, 1);
    } finally { s.store.close(); }
  });
});

describe("R57 — possibly dead, never dead", () => {
  test("an unconfirmed static edge is counted after the cutoff", () => {
    const store = new FactStore(join(dir, "dead.db"));
    try {
      const repoId = store.upsertRepo("svc", "/tmp/svc", "svc");
      const runId = store.startRun(repoId, "static", "t", "");
      const fileId = store.upsertFile(repoId, "s.js", "js", "h", runId);
      const a = store.upsertNode("symbol", "scip npm svc 1 `s.js`/a().", repoId);
      const b = store.upsertNode("symbol", "scip npm svc 1 `s.js`/b().", repoId);
      store.insertEdge({
        srcNodeId: a, dstNodeId: b, type: "CALLS", confidence: "certain",
        evidenceKind: "scip", fileId, line: 1, runId,
      });
      assert.equal(countPossiblyDead(store, 30), 1);

      // A boot edge is not a candidate: the framework reported it this run.
      store.insertEdge({
        srcNodeId: a, dstNodeId: b, type: "HANDLES", confidence: "certain",
        evidenceKind: "boot", fileId, line: 2, runId,
      });
      assert.equal(countPossiblyDead(store, 30), 1, "still just the static one");
    } finally { store.close(); }
  });
});

describe("the receiver", () => {
  test("accepts OTLP/HTTP JSON and writes rows", async () => {
    const store = new FactStore(join(dir, "recv.db"));
    const receiver = await startReceiver(store, { port: 0, successRate: 1 });
    try {
      const res = await fetch(`http://127.0.0.1:${receiver.port}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload([otlpSpan({ attributes: [kv("http.route", "/x")] })])),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { partialSuccess: {} });
      assert.equal(store.countRows("spans"), 1);
    } finally {
      await receiver.close();
      store.close();
    }
  });

  test("a protobuf body gets an error that names the fix", async () => {
    const store = new FactStore(join(dir, "recv-bad.db"));
    const receiver = await startReceiver(store, { port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${receiver.port}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/x-protobuf" },
        body: Buffer.from([0x0a, 0x56, 0x12]),
      });
      assert.equal(res.status, 400);
      const body = await res.json() as { hint: string };
      assert.match(body.hint, /http\/json/);
    } finally {
      await receiver.close();
      store.close();
    }
  });

  test("shutdown flushes buffered traces rather than dropping them", async () => {
    // A trace whose root had not arrived is exactly the kind most likely to be
    // the errored one.
    const store = new FactStore(join(dir, "recv-flush.db"));
    const receiver = await startReceiver(store, {
      port: 0, successRate: 1, completionMs: 1_000_000,
    });
    try {
      await fetch(`http://127.0.0.1:${receiver.port}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload([otlpSpan({ spanId: "c", parentSpanId: "r" })])),
      });
      assert.equal(store.countRows("spans"), 0, "held, not yet decided");
      const { flushed } = await receiver.close();
      assert.equal(flushed, 1);
      assert.equal(store.countRows("spans"), 1);
    } finally { store.close(); }
  });

  test("healthz reports how many traces are buffered", async () => {
    const store = new FactStore(join(dir, "recv-health.db"));
    const receiver = await startReceiver(store, { port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${receiver.port}/healthz`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, bufferedTraces: 0 });
    } finally {
      await receiver.close();
      store.close();
    }
  });
});
