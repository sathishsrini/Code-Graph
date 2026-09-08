// Tests for the intra-function CFG and guard attribution
// (tasks P1-T17 / P1-T18, requirements R75, R76, R77).
//
// Written against the idioms the corpus actually uses, because that is why the
// v2 addition exists: `THROWS` is ZERO on every backend service here (D12), so
// a throw-only failure surface finds nothing at all. Every test below that
// matters is about the return-an-error-value form.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactStore } from "../src/store/db.ts";
import { parseFile } from "../src/static/treesitter/parser.ts";
import { extract } from "../src/static/treesitter/extract.ts";
import { extractCfg, blockAt, isErrorOnly, type CfgBlock } from "../src/static/cfg.ts";
import { ingestCfgs, readCfg, callsOnErrorPath } from "../src/static/cfg-ingest.ts";

const RULES = { errorBuilders: new Set(["envelopeError", "envelope_error"]) };

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), "code-intel-cfg-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

async function cfgOf(path: string, source: string, fnName?: string): Promise<CfgBlock[]> {
  const parsed = await parseFile(path, source);
  assert.ok(parsed);
  const findings = extract(parsed);
  const cfgs = extractCfg(parsed, findings.functions, RULES);
  const picked = fnName ? cfgs.find((c) => c.fn.name === fnName) : cfgs[0];
  assert.ok(picked, `no CFG for ${fnName ?? "the first function"}`);
  return picked.blocks;
}

const exits = (b: CfgBlock[]) => b.filter((x) => x.kind === "exit");

describe("R76 — the return-an-error-value form", () => {
  test("the sentinel guard: `if (authErr) return authErr;`", async () => {
    // The corpus's dominant guard. The return is the CONSEQUENCE, not inside a
    // block, so a walk that only descends into children emits no exit at all —
    // the guard is recorded with no outcome and the branch renders as neither
    // success nor error.
    const blocks = await cfgOf("s.js", [
      "function h(req, reply) {",
      "  const authErr = checkUserAuth(req, reply);",
      "  if (authErr) return authErr;",
      "  return doWork();",
      "}",
    ].join("\n"), "h");

    const guard = blocks.find((b) => b.kind === "guard");
    assert.ok(guard, "an if whose consequence exits is a guard, not a branch");
    assert.equal(guard.conditionText, "authErr");

    const sentinelExit = exits(blocks).find((e) => e.errorName === "authErr");
    assert.equal(sentinelExit?.outcome, "error_exit");
    assert.equal(sentinelExit?.exitForm, "return_error");
    assert.equal(sentinelExit?.parentIndex, guard.blockIndex, "the exit sits INSIDE the guard");
  });

  test("a reviewed error builder in return position", async () => {
    const blocks = await cfgOf("s.js", [
      "function h() {",
      "  if (!token) return envelopeError({ code: 'KRI40-AUTH-001' });",
      "  return ok();",
      "}",
    ].join("\n"), "h");
    const err = exits(blocks).find((e) => e.outcome === "error_exit");
    assert.equal(err?.exitForm, "return_error");
    assert.equal(err?.errorName, "KRI40-AUTH-001", "the error CODE, not the builder name");
  });

  test("an error built into a variable and returned indirectly", async () => {
    // The corpus's most common shape, and the one that classified as SUCCESS
    // before the binding was tracked: the error is built a few lines earlier
    // and returned through a framework call with no literal status.
    const blocks = await cfgOf("s.js", [
      "function h(reply) {",
      "  try { return ok(); }",
      "  catch (e) {",
      "    const body = envelopeError({ code: 'KRI40-DOWNSTREAM-001' });",
      "    return reply.status(body.status_code).send(body);",
      "  }",
      "}",
    ].join("\n"), "h");
    const err = exits(blocks).find((e) => e.outcome === "error_exit");
    assert.ok(err, "an indirect error return is still an error exit");
    assert.equal(err.errorName, "KRI40-DOWNSTREAM-001");
  });

  test("a 4xx status literal is structural — no vocabulary needed", async () => {
    const blocks = await cfgOf("s.js", [
      "function h(reply) {",
      "  if (!ok) return reply.status(403).send({});",
      "  return reply.status(200).send({});",
      "}",
    ].join("\n"), "h");
    const outcomes = exits(blocks).map((e) => `${e.outcome}:${e.errorName ?? ""}`);
    assert.ok(outcomes.includes("error_exit:HTTP 403"));
    assert.ok(outcomes.includes("success:"), "200 is not an error");
  });

  test("throw is still detected, in both languages", async () => {
    const js = await cfgOf("s.js", "function h(){ throw new ValidationError('x'); }", "h");
    assert.equal(exits(js)[0]?.exitForm, "throw");
    assert.equal(exits(js)[0]?.errorName, "ValidationError");

    const py = await cfgOf("s.py", "def h():\n    raise HTTPException(status_code=400)", "h");
    assert.equal(exits(py)[0]?.outcome, "error_exit");
    assert.equal(exits(py)[0]?.errorName, "HTTPException");
  });

  test("an unrecognised return is `unknown`, never `success`", async () => {
    // Guessing green is the one unsafe direction: a branch silently classified
    // as succeeding renders as a success path in P2-T12.
    const blocks = await cfgOf("s.js", [
      "function h() {",
      "  const result = mystery();",
      "  return result;",
      "}",
    ].join("\n"), "h");
    assert.equal(exits(blocks)[0]?.outcome, "unknown");
  });

  test("an ordinary value return is success", async () => {
    const blocks = await cfgOf("s.js", "function h(){ return { ok: true }; }", "h");
    assert.equal(exits(blocks)[0]?.outcome, "success");
    assert.equal(exits(blocks)[0]?.exitForm, "return_value");
  });
});

describe("R75 — structure", () => {
  test("an if whose consequence does NOT exit is a branch, not a guard", async () => {
    const blocks = await cfgOf("s.js", [
      "function h() {",
      "  if (x) { log(); }",
      "  return 1;",
      "}",
    ].join("\n"), "h");
    assert.equal(blocks.find((b) => b.conditionText === "x")?.kind, "branch");
  });

  test("try / catch / finally each get a block, and nest", async () => {
    const blocks = await cfgOf("s.js", [
      "function h() {",
      "  try { a(); }",
      "  catch (e) { b(); }",
      "  finally { c(); }",
      "}",
    ].join("\n"), "h");
    const kinds = new Set<string>(blocks.map((b) => b.kind));
    for (const k of ["try", "catch", "finally"]) assert.ok(kinds.has(k), k);
    assert.equal(blocks.find((b) => b.kind === "catch")?.conditionText, "e", "the caught binding");
  });

  test("nesting is recorded as a parent chain", async () => {
    const blocks = await cfgOf("s.js", [
      "function h() {",
      "  if (a) {",
      "    if (b) { return 1; }",
      "  }",
      "  return 2;",
      "}",
    ].join("\n"), "h");
    const outer = blocks.find((b) => b.conditionText === "a")!;
    const inner = blocks.find((b) => b.conditionText === "b")!;
    assert.equal(inner.parentIndex, outer.blockIndex);
    assert.equal(outer.parentIndex, 0, "the root");
  });

  test("a nested closure is NOT merged into its parent's flow", async () => {
    // Two functions, two CFGs. Merging them would attribute the callback's
    // exits to the outer function.
    const blocks = await cfgOf("s.js", [
      "function outer() {",
      "  items.map(function inner() { throw new Error('x'); });",
      "  return 1;",
      "}",
    ].join("\n"), "outer");
    assert.deepEqual(exits(blocks).map((e) => e.outcome), ["success"]);
  });

  test("loops get a block and keep their condition", async () => {
    const blocks = await cfgOf("s.js", "function h(){ while (more()) { step(); } return 1; }", "h");
    assert.equal(blocks.find((b) => b.kind === "loop")?.conditionText, "more()");
  });
});

describe("blockAt and isErrorOnly", () => {
  test("blockAt picks the innermost block containing a line", async () => {
    const blocks = await cfgOf("s.js", [
      "function h() {",          // 1
      "  try {",                 // 2
      "    if (a) {",            // 3
      "      call();",           // 4
      "    }",                   // 5
      "  } catch (e) {}",        // 6
      "}",                       // 7
    ].join("\n"), "h");
    const at = blockAt(blocks, 4);
    assert.equal(blocks[at]?.conditionText, "a", "the branch, not the enclosing try");
  });

  test("a line outside every nested block belongs to the root", async () => {
    const blocks = await cfgOf("s.js", "function h(){\n  call();\n  return 1;\n}", "h");
    assert.equal(blockAt(blocks, 2), 0);
  });

  test("isErrorOnly is false when any exit below is not an error", async () => {
    const blocks = await cfgOf("s.js", [
      "function h() {",
      "  if (a) { return envelopeError({ code: 'E-1' }); }",
      "  if (b) { return ok(); }",
      "  return 1;",
      "}",
    ].join("\n"), "h");
    const errGuard = blocks.find((b) => b.conditionText === "a")!;
    const okGuard = blocks.find((b) => b.conditionText === "b")!;
    assert.equal(isErrorOnly(blocks, errGuard.blockIndex), true);
    assert.equal(isErrorOnly(blocks, okGuard.blockIndex), false);
  });
});

describe("R77 — guard attribution in the store", () => {
  test("an edge is attributed to the innermost block containing its call site", async () => {
    const store = new FactStore(join(dir, "attrib.db"));
    try {
      const repoId = store.upsertRepo("svc", "/tmp/svc", "svc");
      const runId = store.startRun(repoId, "static", "t", "");
      const fileId = store.upsertFile(repoId, "s.js", "js", "h", runId);

      const source = [
        "function h(reply) {",                                   // 1
        "  const authErr = check();",                            // 2
        "  if (authErr) { audit(); return authErr; }",           // 3
        "  return work();",                                      // 4
        "}",                                                     // 5
      ].join("\n");
      const parsed = await parseFile("s.js", source);
      const findings = extract(parsed!);
      const cfgs = extractCfg(parsed!, findings.functions, RULES);

      const key = "scip npm svc 1 `s.js`/h().";
      const nodeId = store.upsertNode("symbol", key, repoId);
      store.upsertSymbol({
        nodeId, fileId, displayName: "h", symbolKind: "method", startLine: 1, endLine: 5,
      });
      const audit = store.upsertNode("symbol", "scip npm svc 1 `s.js`/audit().", repoId);
      const work = store.upsertNode("symbol", "scip npm svc 1 `s.js`/work().", repoId);
      for (const [dst, line] of [[audit, 3], [work, 4]] as const) {
        store.insertEdge({
          srcNodeId: nodeId, dstNodeId: dst, type: "CALLS", confidence: "certain",
          evidenceKind: "scip", fileId, line, runId,
        });
      }

      const counts = ingestCfgs({
        store, ranges: [{ symbol: key, file: "s.js", startLine: 1, endLine: 5, size: 4 }],
        path: "s.js", fileId, runId, nodeIdOf: () => nodeId,
      }, cfgs);

      assert.equal(counts.functions, 1);
      assert.equal(counts.attributed, 2);

      const stored = readCfg(store, nodeId);
      assert.ok(stored.length > 1, "the CFG round-trips");

      const guarded = callsOnErrorPath(store, nodeId);
      assert.deepEqual(
        guarded.map((g) => `${g.callee.split("/").pop()}@${g.condition}`),
        ["audit().@authErr"],
        "audit runs only through the error guard; work does not",
      );
    } finally { store.close(); }
  });

  test("a function with no symbol is counted as unkeyed, not silently skipped", async () => {
    // An anonymous handler has no SCIP definition and the module is not an
    // owner. The CFG is still extracted; there is just nowhere to key it, and
    // inventing a key would add a second identity system beside SCIP's.
    const store = new FactStore(join(dir, "unkeyed.db"));
    try {
      const repoId = store.upsertRepo("svc", "/tmp/svc", "svc");
      const runId = store.startRun(repoId, "static", "t", "");
      const fileId = store.upsertFile(repoId, "s.js", "js", "h", runId);
      const parsed = await parseFile("s.js", "app.get('/x', () => { return 1; });");
      const findings = extract(parsed!);
      const counts = ingestCfgs(
        { store, ranges: [], path: "s.js", fileId, runId, nodeIdOf: () => null },
        extractCfg(parsed!, findings.functions, RULES),
      );
      assert.equal(counts.functions, 0);
      assert.ok(counts.unkeyed > 0, "reported as a gap");
    } finally { store.close(); }
  });

  test("a CFG is replaced wholesale, never merged", async () => {
    const store = new FactStore(join(dir, "replace.db"));
    try {
      const repoId = store.upsertRepo("svc", "/tmp/svc", "svc");
      const runId = store.startRun(repoId, "static", "t", "");
      const fileId = store.upsertFile(repoId, "s.js", "js", "h", runId);
      const nodeId = store.upsertNode("symbol", "scip npm svc 1 `s.js`/h().", repoId);

      const block = (blockIndex: number) => ({
        symbolNodeId: nodeId, blockIndex, parentIndex: blockIndex === 0 ? null : 0,
        kind: blockIndex === 0 ? "root" as const : "branch" as const,
        startLine: 1, endLine: 9, fileId, runId,
      });
      store.replaceCfg(nodeId, [block(0), block(1), block(2)]);
      assert.equal(readCfg(store, nodeId).length, 3);

      // A later run finds one fewer branch — the stale one must not survive.
      store.replaceCfg(nodeId, [block(0), block(1)]);
      assert.equal(readCfg(store, nodeId).length, 2);
    } finally { store.close(); }
  });

  test("a CFG is purged with its file's provenance (R28)", async () => {
    const store = new FactStore(join(dir, "purge.db"));
    try {
      const repoId = store.upsertRepo("svc", "/tmp/svc", "svc");
      const runId = store.startRun(repoId, "static", "t", "");
      const fileId = store.upsertFile(repoId, "s.js", "js", "h", runId);
      const nodeId = store.upsertNode("symbol", "scip npm svc 1 `s.js`/h().", repoId);
      store.replaceCfg(nodeId, [{
        symbolNodeId: nodeId, blockIndex: 0, parentIndex: null, kind: "root",
        startLine: 1, endLine: 9, fileId, runId,
      }]);
      assert.equal(store.deleteCfgByProvenance(fileId), 1);
      assert.deepEqual(readCfg(store, nodeId), []);
    } finally { store.close(); }
  });
});
