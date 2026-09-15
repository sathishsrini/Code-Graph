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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactStore } from "../src/store/db.ts";
import { callTool, TOOLS } from "../src/mcp/server.ts";
import { buildSearchIndex } from "../src/index/search.ts";

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
  test("the four queries R48 names are all still exposed", () => {
    // Split from the exact-set assertion below on purpose. This one guards the
    // Phase 1 gate: R48's four must never be REMOVED. The other guards against
    // tools appearing that nothing documents. A single deepEqual conflated
    // "you broke the contract" with "you added something", which are different
    // failures needing different fixes.
    const names: string[] = TOOLS.map((t) => t.name);
    for (const required of ["context_pack", "endpoint_flow", "impact", "security_path"]) {
      assert.ok(names.includes(required), `R48 requires ${required}`);
    }
  });

  test("the exposed tool set is exactly what is documented", () => {
    assert.deepEqual(
      TOOLS.map((t) => t.name).sort(),
      ["context_pack", "endpoint_flow", "impact", "search", "security_path"],
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

// ---------------------------------------------------------------------------
// search (P3-T6, R79) — the entry point a model has when it has only a phrase
// ---------------------------------------------------------------------------
describe("search over MCP", () => {
  const built = (name: string): FactStore => {
    const store = seeded(name);
    buildSearchIndex(store);
    return store;
  };

  test("a phrase resolves to ranked candidates and a follow-up query", () => {
    const store = built("search-hit.db");
    try {
      const out = callTool(store, "search", { phrase: "handler" });
      assert.ok(out.includes("candidates["), "the table is present");
      assert.ok(out.includes("indexBuilt: true"));
      assert.ok(out.includes("follow: impact"), "it names the next query");
    } finally { store.close(); }
  });

  test("NO numeric score reaches the model", () => {
    // CLAUDE.md rule 4: confidence is an enum, never a number. A rank is an
    // ordinal; an RRF score shown to a model gets read as a probability.
    const store = built("search-noscore.db");
    try {
      const out = callTool(store, "search", { phrase: "handler" });
      assert.ok(
        out.includes("candidates[1]{rank,kind,display,where,signals,key}:"),
        "the columns are exactly the ordinal ones",
      );
      for (const banned of ["score", "bm25", "cosine", "rrf"]) {
        assert.ok(!out.toLowerCase().includes(banned), `${banned} must not be emitted`);
      }
    } finally { store.close(); }
  });

  test("a phrase that matches nothing is a result with a next move, not an error", () => {
    const store = built("search-miss.db");
    try {
      const out = callTool(store, "search", { phrase: "zzz nothing here" });
      assert.ok(!out.startsWith("error"), "a miss is an answer");
      assert.ok(out.includes("candidates[0]:"), "the empty table is still named");
      assert.ok(out.includes("feature_pack"), "it points at the manifest path");
    } finally { store.close(); }
  });

  test("kinds filters before the top-K cut, so a low-ranked route still surfaces", () => {
    // The corpus failure this prevents: `grn` puts nineteen form-field
    // variables above the two routes actually named /api/v1/grn. Filtering
    // after an 8-row slice would return nothing at all.
    const store = built("search-kinds.db");
    try {
      const out = callTool(store, "search", { phrase: "p", kinds: ["route"] });
      for (const line of out.split("\n")) {
        if (/^ {2}\d+,/.test(line)) {
          assert.ok(line.includes(",route,"), `only routes: ${line}`);
        }
      }
    } finally { store.close(); }
  });

  test("an explicit seed overrides the ranking and says so", () => {
    const store = built("search-seed.db");
    try {
      const out = callTool(store, "search", {
        phrase: "anything", seed: "scip npm svc 1 `server.js`/helper().",
      });
      assert.ok(out.includes("corrected from"), "the override is reported");
      assert.ok(out.includes("helper"));
    } finally { store.close(); }
  });

  test("an unbuilt index reports itself rather than looking like a miss", () => {
    // "Nothing matched" and "nothing was indexed" are different facts, and a
    // model that cannot tell them apart concludes the code does not exist.
    const store = seeded("search-unbuilt.db");
    try {
      const out = callTool(store, "search", { phrase: "handler" });
      assert.ok(out.includes("indexBuilt: false"));
      assert.ok(out.includes("search build"), "it names the command that fixes it");
    } finally { store.close(); }
  });

  test("the ranking note tells the model the order is not a confidence", () => {
    const tool = TOOLS.find((t) => t.name === "search")!;
    assert.ok(tool.description.includes("RANKING, not a confidence"));
    assert.ok(
      tool.description.includes("never evidence"),
      "an empty result is not proof of absence",
    );
  });
});
