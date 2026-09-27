// Tests for the MCP tool layer (task P1-T16, R48) — the Phase 1 gate.
//
// `callTool` is exported and store-injected precisely so this file can exist.
// An MCP server whose logic is only reachable through a stdio transport is a
// server nobody writes a test for.
//
// The properties under test are the three that make an MCP server help rather
// than hurt: output is packed, a "not found" is an answer rather than a
// transport error, and the confidence semantics reach the model.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactStore } from "../src/store/db.ts";
import { callTool, TOOLS } from "../src/mcp/server.ts";

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), "code-intel-mcp-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

function seeded(name: string): FactStore {
  const store = new FactStore(join(dir, name));
  const repoId = store.upsertRepo("svc", "/tmp/svc", "svc");
  const runId = store.startRun(repoId, "static", "test@0", "");
  const fileId = store.upsertFile(repoId, "server.js", "js", "h", runId);

  const handler = store.upsertNode("symbol", "scip npm svc 1 `server.js`/handler().", repoId);
  const helper = store.upsertNode("symbol", "scip npm svc 1 `server.js`/helper().", repoId);
  for (const [id, n] of [[handler, "handler"], [helper, "helper"]] as const) {
    store.upsertSymbol({
      nodeId: id, fileId, displayName: n, symbolKind: "method",
      signature: `function ${n}()`, startLine: 10, endLine: 20,
    });
  }
  store.insertEdge({
    srcNodeId: handler, dstNodeId: helper, type: "CALLS", confidence: "inferred",
    evidenceKind: "scip", fileId, line: 11, runId,
  });

  const route = store.upsertNode("route", "svc POST /p", repoId);
  store.upsertRoute({
    nodeId: route, repoId, serviceName: "svc", method: "POST", url: "/p",
    source: "boot", runId,
  });
  store.insertChainEntry({
    routeNodeId: route, position: 0, phase: "handler", origin: "route",
    symbolNodeId: handler, name: "handler", confidence: "certain",
    evidenceKind: "boot", key: "server.js:10:0", fileId, line: 10, runId,
  });
  store.insertChainEntry({
    routeNodeId: route, position: 0, phase: "handler_inline", origin: "handler",
    name: "checkUserAuth", checkKind: "auth", confidence: "inferred",
    evidenceKind: "treesitter", detail: "reviewed helper checkUserAuth",
    key: "server.js:11:4", fileId, line: 11, runId,
  });
  store.insertEdge({
    srcNodeId: route, dstNodeId: handler, type: "HANDLES", confidence: "certain",
    evidenceKind: "boot", fileId, line: 10, runId,
  });
  store.insertUnresolved({
    srcNodeId: handler, kind: "call", targetHint: "npm axios",
    reason: "callee resolved to a package", fileId, line: 68, runId,
  });
  return store;
}

describe("the tool contract", () => {
  test("exactly R48's four queries plus CTX-S13's error_trace are exposed", () => {
    assert.deepEqual(
      TOOLS.map((t) => t.name).sort(),
      ["context_pack", "endpoint_flow", "error_trace", "impact", "security_path"],
    );
  });

  test("every tool documents its confidence semantics to the model", () => {
    // A model that does not know 'inferred' exists will read an inferred edge
    // as fact. The description is part of the contract, not documentation.
    for (const tool of TOOLS) {
      const d = tool.description.toLowerCase();
      assert.ok(
        d.includes("inferred") || d.includes("confidence") || d.includes("engine can see"),
        `${tool.name} must state what its confidence values mean`,
      );
    }
  });

  test("security_path's description refuses the question it cannot answer", () => {
    const d = TOOLS.find((t) => t.name === "security_path")!.description;
    assert.ok(d.includes("does NOT answer whether"), "authorization correctness is out of scope");
    assert.ok(d.includes("Never report a route as secure"));
  });

  test("every tool declares its required arguments", () => {
    for (const tool of TOOLS) {
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(Object.keys(tool.inputSchema.properties).length > 0, tool.name);
    }
  });
});

describe("output is packed for a model (R44)", () => {
  test("results are TOON, not JSON", () => {
    // Returning the raw report would undo the packing the pack exists for.
    const store = seeded("toon.db");
    try {
      const out = callTool(store, "endpoint_flow", {
        service: "svc", method: "POST", path: "/p",
      });
      assert.ok(out.includes("chain[") && out.includes("{position,"), out.slice(0, 120));
      assert.ok(!out.trimStart().startsWith("{"), "not JSON");
    } finally { store.close(); }
  });

  test("context_pack reports what it replaced, so the model can trust it", () => {
    const store = seeded("ctx.db");
    try {
      const out = callTool(store, "context_pack", { symbol: "handler", includeSource: false });
      assert.ok(out.includes("tokensVsFileDump"));
      assert.ok(out.includes("filesThisReplaces"));
    } finally { store.close(); }
  });
});

describe("a miss is an answer, not a transport error", () => {
  test("an unknown route returns the routes that DO exist", () => {
    const store = seeded("noroute.db");
    try {
      const out = callTool(store, "endpoint_flow", {
        service: "svc", method: "GET", path: "/nope",
      });
      assert.ok(out.includes("error:"));
      assert.ok(out.includes("POST /p") || out.includes("/p"), "the model can pick from these");
    } finally { store.close(); }
  });

  test("an ambiguous symbol returns the candidates", () => {
    const store = new FactStore(join(dir, "ambig.db"));
    try {
      for (const svc of ["a", "b"]) {
        const repoId = store.upsertRepo(svc, `/tmp/${svc}`, svc);
        const runId = store.startRun(repoId, "static", "t", "");
        const fileId = store.upsertFile(repoId, "s.js", "js", `h${svc}`, runId);
        const id = store.upsertNode("symbol", `scip npm ${svc} 1 \`s.js\`/dup().`, repoId);
        store.upsertSymbol({ nodeId: id, fileId, displayName: "dup", symbolKind: "method" });
      }
      const out = callTool(store, "impact", { symbol: "dup" });
      assert.ok(out.includes("ambiguous"));
      assert.ok(out.includes("candidates["));
    } finally { store.close(); }
  });

  test("an unknown tool name lists the ones that exist", () => {
    const store = seeded("unknown.db");
    try {
      const out = callTool(store, "not_a_tool", {});
      assert.ok(out.includes("unknown tool"));
      assert.ok(out.includes("endpoint_flow"));
    } finally { store.close(); }
  });
});

describe("the two security channels survive the MCP boundary", () => {
  test("endpoint_flow labels the inline check as inferred, separately from boot", () => {
    const store = seeded("channels.db");
    try {
      const out = callTool(store, "endpoint_flow", {
        service: "svc", method: "POST", path: "/p",
      });
      assert.ok(out.includes("handler,handler,boot,certain"), "the boot entry");
      assert.ok(out.includes("handler_inline,checkUserAuth,inferred"), "and the weaker one");
    } finally { store.close(); }
  });

  test("security_path keeps boot and inferred in separate columns", () => {
    const store = seeded("sec.db");
    try {
      const out = callTool(store, "security_path", {});
      const row = out.split("\n").find((l) => l.includes("POST /p"))!;
      // boot column empty, inferred column carries auth — never merged.
      assert.ok(row.includes(",auth,"), row);
    } finally { store.close(); }
  });
});

describe("gaps reach the model", () => {
  test("endpoint_flow carries unresolved call sites", () => {
    const store = seeded("gaps.db");
    try {
      const out = callTool(store, "endpoint_flow", {
        service: "svc", method: "POST", path: "/p",
      });
      assert.ok(out.includes("gaps["), "R61's section is present");
      assert.ok(out.includes("resolved to a package"));
    } finally { store.close(); }
  });

  test("impact says runtime coupling is unavailable rather than empty", () => {
    const store = seeded("runtime.db");
    try {
      const out = callTool(store, "impact", { symbol: "helper" });
      assert.ok(out.includes("P2-T8"), "'no producer', not 'no traffic'");
    } finally { store.close(); }
  });
});

describe("context_pack hands Claude read ranges (CTX-S7)", () => {
  test("the description tells Claude to Read the ranges with offset/limit", () => {
    const d = TOOLS.find((t) => t.name === "context_pack")!.description;
    assert.ok(d.includes("readRanges"), "names the section");
    assert.ok(d.includes("offset") && d.includes("limit"), "names the Read arguments");
  });

  test("the output carries the ranges", () => {
    const store = seeded("ranges.db");
    try {
      const out = callTool(store, "context_pack", { symbol: "handler", includeSource: false });
      assert.ok(out.includes("readRanges[1]{file,start,end,symbols}:"), out);
      assert.ok(out.includes(`${join("/tmp/svc", "server.js")},10,20,seed:handler|callee:helper`));
    } finally { store.close(); }
  });

  test("the whole tool list stays under 2,000 tokens", () => {
    // Tool descriptions are what ToolSearch matches on and every session pays
    // for them. bytes / 4, the convention of scripts/workflow-bench-score.ts.
    assert.ok(JSON.stringify(TOOLS).length / 4 < 2000);
  });
});

// ---------------------------------------------------------------------------
// error_trace  —  slice CTX-S13 (goal G6; R41, R59, R60, R61)
// ---------------------------------------------------------------------------
// The CLI's `errors` report, over MCP. The fixture's repo root is a real git
// repository in a temp dir, so CORRELATED CHANGES reads actual history rather
// than a stub, and the spans are the shape `otlp serve` stores.

const SECTIONS = ["OBSERVED", "STATIC FAILURE SURFACE", "CORRELATED CHANGES", "UNKNOWN"];

/** One section of an error_trace answer: its heading line up to the next heading. */
function section(out: string, heading: string): string {
  const start = out.indexOf(`\n${heading}`);
  assert.ok(start >= 0, `the ${heading} section is present:\n${out}`);
  const ends = SECTIONS.map((h) => out.indexOf(`\n${h}`, start + 1)).filter((i) => i > start);
  return out.slice(start + 1, ends.length > 0 ? Math.min(...ends) : undefined);
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", [
    "-C", root, "-c", "user.name=Fixture Author", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", ...args,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A temp git repo with one commit per file; returns each file's short sha. */
function gitRepo(root: string, files: string[]): Map<string, string> {
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  const shas = new Map<string, string>();
  for (const file of files) {
    writeFileSync(join(root, file), `// ${file}\n`);
    git(root, "add", file);
    git(root, "commit", "-q", "-m", `touch ${file} before the outage`);
    shas.set(file, git(root, "rev-parse", "--short", "HEAD"));
  }
  return shas;
}

interface SpanRow {
  trace?: string; id: string; parent: string | null; name: string; start: number;
  status?: string; urlPath?: string; httpStatus?: number; exType?: string; exMsg?: string;
  fn?: string; fnPath?: string;
}

/** A span as `otlp serve` stores it. No http.route, as measured (M10). */
function insertSpan(store: FactStore, s: SpanRow): void {
  store.raw().prepare(
    `INSERT INTO spans (trace_id, span_id, parent_span_id, name, kind, service_name,
       start_unix_us, end_unix_us, duration_us, status, exception_type, exception_message,
       http_status, code_function, code_filepath, url_path, semconv, received_at)
     VALUES (?, ?, ?, ?, 'internal', 'svc', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, '1.27.0', datetime('now'))`,
  ).run(
    s.trace ?? "t1", s.id, s.parent, s.name, s.start, s.start + 1, s.status ?? "error",
    s.exType ?? null, s.exMsg ?? null, s.httpStatus ?? null,
    s.fn ?? null, s.fnPath ?? null, s.urlPath ?? null,
  );
}

/**
 * svc `POST /p`: handler (s.js:10) calls dbQuery (s.js:30). Statically, dbQuery
 * returns DB-DOWN when `!conn`. At runtime, trace t1 errors at three levels and
 * the deepest span is dbQuery's. So observed and static AGREE on the function,
 * which is exactly when merging them would be most tempting.
 */
function errorFixture(
  name: string, opts: { codeFunction?: boolean; spans?: boolean; handlerCfg?: boolean } = {},
): { store: FactStore; sha: string } {
  const root = join(dir, `${name}-repo`);
  const sha = gitRepo(root, ["s.js"]).get("s.js")!;

  const store = new FactStore(join(dir, `${name}.db`));
  const repoId = store.upsertRepo("svc", root, "svc");
  const runId = store.startRun(repoId, "static", "t", "");
  const fileId = store.upsertFile(repoId, "s.js", "js", "h", runId);
  const sym = (n: string, startLine: number): number => {
    const id = store.upsertNode("symbol", `scip npm svc 1 \`s.js\`/${n}().`, repoId);
    store.upsertSymbol({
      nodeId: id, fileId, displayName: n, symbolKind: "function", startLine, endLine: startLine + 9,
    });
    return id;
  };
  const handler = sym("handler", 10);
  const dbQuery = sym("dbQuery", 30);
  store.insertEdge({
    srcNodeId: handler, dstNodeId: dbQuery, type: "CALLS", confidence: "certain",
    evidenceKind: "scip", fileId, line: 12, runId,
  });
  const route = store.upsertNode("route", "svc POST /p", repoId);
  store.upsertRoute({
    nodeId: route, repoId, serviceName: "svc", method: "POST", url: "/p", source: "boot", runId,
  });
  store.insertChainEntry({
    routeNodeId: route, position: 0, phase: "handler", origin: "route",
    symbolNodeId: handler, confidence: "certain", evidenceKind: "boot", fileId, line: 10, runId,
  });

  const block = (
    symbolNodeId: number, blockIndex: number, parentIndex: number | null, kind: string,
    line: number, extra: { condition?: string; error?: string } = {},
  ) => ({
    symbolNodeId, blockIndex, parentIndex, kind, startLine: line, endLine: line, fileId, runId,
    conditionText: extra.condition ?? null,
    outcome: kind === "exit" ? "error_exit" : null,
    exitForm: kind === "exit" ? "return_error" : null,
    errorName: extra.error ?? null,
  });
  store.replaceCfg(dbQuery, [
    block(dbQuery, 0, null, "root", 30),
    block(dbQuery, 1, 0, "guard", 33, { condition: "!conn" }),
    block(dbQuery, 2, 1, "exit", 34, { error: "DB-DOWN" }),
  ]);
  if (opts.handlerCfg) store.replaceCfg(handler, [block(handler, 0, null, "root", 10)]);

  if (opts.spans ?? true) {
    insertSpan(store, { id: "s0", parent: null, name: "POST /p", start: 1_000_000,
      urlPath: "/p", httpStatus: 500 });
    insertSpan(store, { id: "s1", parent: "s0", name: "proxy", start: 1_000_010 });
    insertSpan(store, { id: "s2", parent: "s1", name: "db.query", start: 1_000_020,
      exType: "ConnectionError", exMsg: "connect ECONNREFUSED",
      ...(opts.codeFunction ?? true ? { fn: "dbQuery", fnPath: `${root}/s.js` } : {}) });
  }
  return { store, sha };
}

const ask = (store: FactStore, args: Record<string, unknown> = {}): string =>
  callTool(store, "error_trace", { service: "svc", method: "POST", path: "/p", ...args });

describe("error_trace (CTX-S13): the errors report over MCP", () => {
  test("the origin is the deepest errored span: service, function, file:line, error", () => {
    const { store } = errorFixture("err-origin");
    try {
      const observed = section(ask(store), "OBSERVED");
      const origin = observed.split("\n").find((l) => l.includes("ConnectionError"));
      assert.ok(origin, observed);
      for (const part of ["t1", "svc", "dbQuery", "s.js:30", "connect ECONNREFUSED"]) {
        assert.ok(origin.includes(part), `the origin row names ${part}: ${origin}`);
      }
    } finally { store.close(); }
  });

  test("the path runs from the route's span down to the origin, in that order", () => {
    const { store } = errorFixture("err-path");
    try {
      const observed = section(ask(store), "OBSERVED");
      const path = observed.slice(Math.max(0, observed.indexOf("pathToOrigin[")));
      assert.ok(path.startsWith("pathToOrigin["), observed);
      const at = (s: string): number => path.indexOf(s);
      assert.ok(at("POST /p") > 0, path);
      assert.ok(at("POST /p") < at(",proxy,") && at(",proxy,") < at(",db.query,"), path);
    } finally { store.close(); }
  });

  test("an origin span without code.function.name says the function is unknown, and why", () => {
    // M10: auto-instrumentation does not set code.*. A blank would read as
    // "no function"; the truth is "the span did not say".
    const { store } = errorFixture("err-nofn", { codeFunction: false });
    try {
      const observed = section(ask(store), "OBSERVED");
      const origin = observed.split("\n").find((l) => l.includes("ConnectionError"));
      assert.ok(origin?.includes("no code.function.name"), observed);
    } finally { store.close(); }
  });

  test("OBSERVED and STATIC stay separate sections even when they agree (R41)", () => {
    const { store } = errorFixture("err-apart");
    try {
      const out = ask(store);
      const at = SECTIONS.map((h) => out.indexOf(`\n${h}`));
      assert.ok(at.every((i, n) => i > 0 && (n === 0 || i > at[n - 1]!)), `fixed order:\n${out}`);

      const observed = section(out, "OBSERVED");
      const staticPart = section(out, "STATIC FAILURE SURFACE");
      assert.ok(observed.includes("dbQuery") && staticPart.includes("dbQuery"), "both name it");
      assert.ok(staticPart.includes("DB-DOWN") && staticPart.includes("!conn"), staticPart);
      assert.ok(staticPart.includes("s.js:34"), staticPart);
      assert.ok(!observed.includes("DB-DOWN"), "no static finding inside OBSERVED");
      assert.ok(!staticPart.includes("ConnectionError") && !staticPart.includes("t1,"),
        "no trace inside STATIC");
      assert.match(observed, /runtime traces/i, "OBSERVED says it is runtime evidence");
      assert.match(staticPart, /parser/i, "STATIC says it is parser-found");
    } finally { store.close(); }
  });

  test("CORRELATED CHANGES comes from the git history of the files on the path", () => {
    const { store, sha } = errorFixture("err-git");
    try {
      const correlated = section(ask(store), "CORRELATED CHANGES");
      assert.ok(correlated.includes(sha), `the commit ${sha}:\n${correlated}`);
      assert.ok(correlated.includes("touch s.js before the outage"), correlated);
      assert.ok(correlated.includes("never a cause"), "a ranking signal, labelled as one");
    } finally { store.close(); }
  });

  test("the UNKNOWN line is always there, and an empty store is not 'nothing failed'", () => {
    const { store: empty } = errorFixture("err-nospans", { spans: false });
    try {
      const out = ask(empty);
      assert.ok(section(out, "OBSERVED").includes("nothing was recorded"), out);
      assert.ok(section(out, "UNKNOWN").includes("no spans in the store"), out);
    } finally { empty.close(); }

    const { store: clean } = errorFixture("err-clean", { handlerCfg: true });
    try {
      const unknown = section(ask(clean), "UNKNOWN");
      assert.match(unknown, /none/, `emitted even when there is nothing to list:\n${unknown}`);
    } finally { clean.close(); }
  });

  test("an unknown route is an answer: the service's routes, or none", () => {
    const { store } = errorFixture("err-miss", { spans: false });
    try {
      const wrongPath = ask(store, { method: "GET", path: "/nope" });
      assert.ok(wrongPath.includes("error:"), wrongPath);
      assert.ok(wrongPath.includes("POST /p"), "the model can pick from these");

      const wrongService = ask(store, { service: "ghost" });
      assert.ok(wrongService.includes("error:"), wrongService);
      assert.match(wrongService, /none/, "says there are none rather than an empty list");
      assert.ok(wrongService.includes("svc"), "and names the services that do exist");
    } finally { store.close(); }
  });

  test("the description says what observed and static mean", () => {
    const d = TOOLS.find((t) => t.name === "error_trace")?.description ?? "";
    assert.match(d, /runtime traces/, "observed = runtime traces");
    assert.match(d, /parser/, "static = parser-found surface");
    assert.match(d, /never merged/);
    assert.ok(d.includes("Treat 'inferred' as a lead"), "CONFIDENCE_NOTE");
  });

  test("a large route stays under Claude Code's 10,000-token MCP output warning", () => {
    // Well past the corpus, whose router has 7 error exits in all: 60 reachable
    // functions x 2 exits over 20 files, one commit per file, and the full 5
    // errored traces (errorPaths' cap; 7 are recorded) at depth 8.
    const root = join(dir, "err-large-repo");
    const files = Array.from({ length: 20 }, (_, i) => `module-${i}.js`);
    gitRepo(root, files);
    const store = new FactStore(join(dir, "err-large.db"));
    try {
      const repoId = store.upsertRepo("svc", root, "svc");
      const runId = store.startRun(repoId, "static", "t", "");
      const fileIds = files.map((f, i) => store.upsertFile(repoId, f, "js", `h${i}`, runId));
      const url = "/api/v1/purchase-orders/:id/approve";
      const handler = store.upsertNode("symbol", "scip npm svc 1 `module-0.js`/handler().", repoId);
      store.upsertSymbol({ nodeId: handler, fileId: fileIds[0]!, displayName: "handler", startLine: 1 });
      const route = store.upsertNode("route", `svc POST ${url}`, repoId);
      store.upsertRoute({ nodeId: route, repoId, serviceName: "svc", method: "POST", url, source: "boot", runId });
      store.insertChainEntry({
        routeNodeId: route, position: 0, phase: "handler", origin: "route",
        symbolNodeId: handler, confidence: "certain", evidenceKind: "boot", runId,
      });
      for (let i = 0; i < 60; i++) {
        const fileId = fileIds[i % 20]!;
        const name = `validatePurchaseOrderStep${i}`;
        const fn = store.upsertNode("symbol", `scip npm svc 1 \`${files[i % 20]}\`/${name}().`, repoId);
        store.upsertSymbol({ nodeId: fn, fileId, displayName: name, startLine: 10 * i + 1 });
        store.insertEdge({
          srcNodeId: handler, dstNodeId: fn, type: "CALLS", confidence: "inferred",
          evidenceKind: "scip", fileId, line: i + 2, runId,
        });
        const b = { symbolNodeId: fn, fileId, runId, conditionText: null, outcome: null, exitForm: null, errorName: null };
        store.replaceCfg(fn, [
          { ...b, blockIndex: 0, parentIndex: null, kind: "root", startLine: 10 * i + 1, endLine: 10 * i + 9 },
          { ...b, blockIndex: 1, parentIndex: 0, kind: "guard", conditionText: "!req.body || !req.body.approverId", startLine: 10 * i + 2, endLine: 10 * i + 2 },
          { ...b, blockIndex: 2, parentIndex: 1, kind: "exit", outcome: "error_exit", exitForm: "return_error", errorName: `KRI40-PO-VALIDATION-${String(i).padStart(3, "0")}`, startLine: 10 * i + 3, endLine: 10 * i + 3 },
          { ...b, blockIndex: 3, parentIndex: 0, kind: "exit", outcome: "error_exit", exitForm: "throw", errorName: "DownstreamTimeoutError", startLine: 10 * i + 8, endLine: 10 * i + 8 },
        ]);
      }
      for (let t = 0; t < 7; t++) {
        const trace = `4bf92f3577b34da6a3ce929d0e0e47${String(t).padStart(2, "0")}`;
        for (let d = 0; d <= 8; d++) {
          insertSpan(store, {
            trace, id: `span-${t}-${d}`, parent: d === 0 ? null : `span-${t}-${d - 1}`,
            name: d === 0 ? "POST /api/v1/purchase-orders/42/approve" : `validatePurchaseOrderStep${d}`,
            start: 1_000_000 * (t + 1) + d,
            ...(d === 0 ? { urlPath: "/api/v1/purchase-orders/42/approve", httpStatus: 502 } : {}),
            ...(d > 0 ? { fn: `validatePurchaseOrderStep${d}`, fnPath: `${root}/${files[d % 20]}` } : {}),
            ...(d === 8 ? { exType: "Error", exMsg: "connect ECONNREFUSED 127.0.0.1:3002 while approving purchase order 42" } : {}),
          });
        }
      }
      const out = callTool(store, "error_trace", { service: "svc", method: "POST", path: url });
      const tokens = Math.ceil(Buffer.byteLength(out, "utf8") / 4);
      assert.ok(section(out, "STATIC FAILURE SURFACE").includes("KRI40-PO-VALIDATION-059"), "every exit is listed");
      assert.ok(section(out, "CORRELATED CHANGES").includes("module-19.js"), "every file's commit");
      assert.ok(tokens < 10_000, `error_trace output is ${tokens} tokens`);
    } finally { store.close(); }
  });
});
