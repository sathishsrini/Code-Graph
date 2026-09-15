// Tests for the decision-structure and model-prose tiers (task P3-T10, R83).
//
// The property under test for `cfg` is the guard path. On the real corpus the
// router has no GRN handler at all — `proxyToEngine` is shared by fifteen
// routes and special-cases the path in an `else` branch at line 205 — so a row
// that says only "there is a branch here" is worth nothing. It has to say
// WHICH arm of WHICH enclosing branch, including the negated sibling.
//
// The property under test for `prose` is containment: R63 says model output
// may never be read as fact, and this asserts the separation is carried by the
// type rather than by a string a renderer could forget.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactStore } from "../src/store/db.ts";
import { cfgRowsFor, CFG_NOTE } from "../src/query/cfg-tier.ts";
import { collectProse } from "../src/llm/prose-tier.ts";
import { writeSummary } from "../src/llm/summaries.ts";

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), "code-intel-cfgtier-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

interface Built { store: FactStore; nodeId: number; }

/** The shape of `proxyToEngine`: a guard, then a nested if/else-if chain. */
function built(name: string): Built {
  const store = new FactStore(join(dir, name));
  const repoId = store.upsertRepo("svc", "/tmp/svc", "svc");
  const runId = store.startRun(repoId, "static", "t@0", "");
  const fileId = store.upsertFile(repoId, "server.js", "js", "h", runId);
  const nodeId = store.upsertNode("symbol", "scip npm svc 1 `server.js`/proxy().", repoId);
  store.upsertSymbol({
    nodeId, fileId, displayName: "proxy", symbolKind: "method", startLine: 168, endLine: 277,
  });

  const b = (
    blockIndex: number, parentIndex: number | null, branchLabel: string | null,
    kind: string, startLine: number,
    extra: Partial<{ conditionText: string; outcome: string; exitForm: string; errorName: string }> = {},
  ) => ({
    symbolNodeId: nodeId, blockIndex, parentIndex, branchLabel, kind,
    conditionText: extra.conditionText ?? null,
    outcome: extra.outcome ?? null,
    exitForm: extra.exitForm ?? null,
    errorName: extra.errorName ?? null,
    startLine, endLine: startLine, fileId, runId,
  });

  store.replaceCfg(nodeId, [
    b(0, null, null, "root", 168),
    b(1, 0, null, "guard", 170, { conditionText: "authErr" }),
    b(2, 1, "then", "exit", 170, { outcome: "error_exit", exitForm: "return_error", errorName: "authErr" }),
    b(3, 0, null, "branch", 196, { conditionText: "isCreateSuccess" }),
    b(4, 3, "then", "branch", 202, { conditionText: "req.url.startsWith('/api/v1/po')" }),
    b(5, 4, "else", "branch", 205, { conditionText: "req.url.startsWith('/api/v1/grn')" }),
    b(6, 0, null, "try", 213),
    b(7, 6, "catch", "catch", 238, { conditionText: "mailErr" }),
    b(8, 0, null, "exit", 261, { outcome: "success", exitForm: "return_value" }),
  ], [
    { symbolNodeId: nodeId, fromBlock: 8, toBlock: null, label: "next", fileId, runId },
  ]);
  return { store, nodeId };
}

describe("the guard path", () => {
  test("an else arm contributes the NEGATED sibling condition", () => {
    // The whole point. Without the negation, `/api/v1/grn` and `/api/v1/po`
    // look like two independent branches rather than an if/else-if chain, and
    // a reader concludes both can run.
    const { store, nodeId } = built("guard.db");
    try {
      const rows = cfgRowsFor(store, nodeId, "server.js");
      const grn = rows.find((r) => r.name.includes("/api/v1/grn"));
      assert.ok(grn, "the branch is reported");
      assert.equal(
        grn.detail,
        "when isCreateSuccess AND NOT(req.url.startsWith('/api/v1/po'))",
      );
      assert.equal(grn.where, "server.js:205");
    } finally { store.close(); }
  });

  test("a block with no enclosing branch reads 'always', not blank", () => {
    const { store, nodeId } = built("always.db");
    try {
      const rows = cfgRowsFor(store, nodeId, "server.js");
      assert.equal(rows.find((r) => r.name === "isCreateSuccess")?.detail, "when always");
    } finally { store.close(); }
  });

  test("a catch arm is 'on-throw', never a condition that was evaluated", () => {
    const { store, nodeId } = built("catch.db");
    try {
      const rows = cfgRowsFor(store, nodeId, "server.js");
      const c = rows.find((r) => r.kind === "catch");
      assert.ok(c?.detail.includes("on-throw"));
    } finally { store.close(); }
  });

  test("an exit names its outcome and its error, outcome first", () => {
    const { store, nodeId } = built("exit.db");
    try {
      const rows = cfgRowsFor(store, nodeId, "server.js");
      assert.ok(rows.some((r) => r.name === "error_exit via return_error (authErr)"));
      assert.ok(rows.some((r) => r.name === "success via return_value"));
    } finally { store.close(); }
  });

  test("an edge to NULL is reported as an implicit return", () => {
    // Only the successor graph knows this. Control reaching the end of a
    // function is a fact about the function, not a gap in the analysis.
    const { store, nodeId } = built("implicit.db");
    try {
      const rows = cfgRowsFor(store, nodeId, "server.js");
      assert.ok(rows.some((r) => r.name === "implicit return"));
    } finally { store.close(); }
  });

  test("a symbol with no extracted CFG returns nothing, not a placeholder", () => {
    const { store } = built("none.db");
    try {
      const other = store.upsertNode("symbol", "scip npm svc 1 `x.js`/other().", 1);
      assert.deepEqual(cfgRowsFor(store, other, "x.js"), []);
    } finally { store.close(); }
  });

  test("the caveat says the guard path is syntactic, not a trace", () => {
    // A reader who takes `when` for an execution trace has merged static and
    // runtime evidence, which this engine refuses everywhere else.
    assert.ok(CFG_NOTE.includes("SYNTACTIC"));
    assert.ok(CFG_NOTE.includes("not an execution trace"));
  });
});

describe("model prose stays on its own side of the line", () => {
  const seeded = (name: string) => {
    const store = new FactStore(join(dir, name));
    writeSummary(store, {
      nodeKey: "svc/a.ts", kind: "function", inputSha256: "h1",
      summary: "reads a purchase order", model: "qwen", provider: "local",
      tokensIn: 10, tokensOut: 5, generatedAt: "2026-01-01T00:00:00Z",
    });
    return store;
  };

  test("a cached note is read back and labelled model-generated", () => {
    const store = seeded("prose.db");
    try {
      const notes = collectProse(store, ["svc/a.ts"]);
      assert.equal(notes.length, 1);
      assert.equal(notes[0]!.origin, "model-generated");
      assert.equal(notes[0]!.text, "reads a purchase order");
      assert.equal(notes[0]!.provider, "local");
    } finally { store.close(); }
  });

  test("one note per node and kind, newest first", () => {
    // The cache keeps every input hash. Three paraphrases of one function are
    // three chances for a reader to believe one of them.
    const store = seeded("dedupe.db");
    try {
      writeSummary(store, {
        nodeKey: "svc/a.ts", kind: "function", inputSha256: "h2",
        summary: "newer wording", model: "qwen", provider: "local",
        tokensIn: 10, tokensOut: 5, generatedAt: "2026-06-01T00:00:00Z",
      });
      assert.equal(store.countRows("summaries"), 2, "both versions are kept");
      const notes = collectProse(store, ["svc/a.ts"]);
      assert.equal(notes.length, 1, "one is reported");
      assert.equal(notes[0]!.text, "newer wording", "and it is the newer one");
    } finally { store.close(); }
  });

  test("an unknown node yields no note rather than an empty one", () => {
    const store = seeded("miss.db");
    try {
      assert.deepEqual(collectProse(store, ["svc/nothing.ts"]), []);
      assert.deepEqual(collectProse(store, []), []);
    } finally { store.close(); }
  });

  test("it never generates — a context query must not load a model", () => {
    // `collectProse` takes no provider and cannot construct one. A pack that
    // silently triggered a weight download is a pack nobody can budget for.
    const store = new FactStore(join(dir, "nogen.db"));
    try {
      assert.deepEqual(collectProse(store, ["svc/a.ts"]), []);
      assert.equal(store.countRows("summaries"), 0, "nothing was written");
    } finally { store.close(); }
  });
});
