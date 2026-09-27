// Tests for the workflow token benchmark's scoring (scripts/workflow-bench.ts).
//
// The bench's numbers are only worth quoting if the arithmetic behind them is
// pinned. These cover the pure half: byte accounting, fact matching, edge
// extraction from code-intel's TOON responses, and precision/recall. The half
// that drives the MCP server is exercised by running the bench itself.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  READ_GUTTER_BYTES, workspaceVariants, shorten, searchable, readCost, tokens,
  splitToonRow, toonScalar, toonTable, workspaceFile, edgesIn, edgeKey,
  scoreQuestion, formatReport, type StepRecord, type GoldenQuestion,
} from "../scripts/workflow-bench-score.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("byte accounting", () => {
  test("the workspace path is shortened to ${ws} in every spelling", () => {
    const ws = "C:\\Temp\\bench\\ws";
    const variants = workspaceVariants(ws);
    // Longest first, so a longer spelling is not half-replaced by a shorter one.
    for (let i = 1; i < variants.length; i += 1) {
      assert.ok(variants[i - 1]!.length >= variants[i]!.length);
    }
    const text = [
      "C:\\Temp\\bench\\ws\\api\\main.py",
      "C:/Temp/bench/ws/api/main.py",
      "C:\\\\Temp\\\\bench\\\\ws\\\\api",
      "file:///C:/Temp/bench/ws/api",
    ].join("\n");
    assert.equal(
      shorten(text, variants),
      "${ws}\\api\\main.py\n${ws}/api/main.py\n${ws}\\\\api\n${ws}/api",
    );
  });

  test("a Read costs the file's bytes plus a 7-byte gutter per line", () => {
    assert.equal(READ_GUTTER_BYTES, 7);
    assert.equal(readCost(enc("")), 0);
    assert.equal(readCost(enc("abc")), 3);            // no newline, no gutter
    assert.equal(readCost(enc("a\nbc\n")), 5 + 2 * 7);
  });

  test("tokens are bytes / 4, rounded half to even like the Python original", () => {
    assert.equal(tokens(0), 0);
    assert.equal(tokens(4), 1);
    assert.equal(tokens(6), 2);    // 1.5 -> 2
    assert.equal(tokens(10), 2);   // 2.5 -> 2, not 3
    assert.equal(tokens(14), 4);   // 3.5 -> 4
    assert.equal(tokens(13), 3);
  });
});

describe("reading code-intel's TOON", () => {
  test("a row splits on commas outside quotes, with doubled quotes unescaped", () => {
    assert.deepEqual(splitToonRow('  a,"b, c",d'), ["a", "b, c", "d"]);
    assert.deepEqual(splitToonRow('x,"say ""hi""",'), ["x", 'say "hi"', ""]);
    assert.deepEqual(splitToonRow('"multi\\nline",z'), ["multi\nline", "z"]);
  });

  test("top-level scalars and named tables are read; nested ones are not scalars", () => {
    const text = [
      "symbol: place_order",
      "file: app/services/order_service.py",
      "directCallers[2]{name,where,confidence}:",
      "  create_order,app/routes/orders.py:10,certain",
      '  "odd, name",app/x.py:3,inferred',
      "transitiveCallers[0]:",
      "nested:",
      "  symbol: not-top-level",
    ].join("\n");
    assert.equal(toonScalar(text, "symbol"), "place_order");
    assert.equal(toonScalar(text, "file"), "app/services/order_service.py");
    assert.equal(toonScalar(text, "missing"), undefined);
    assert.deepEqual(toonTable(text, "directCallers"), [
      { name: "create_order", where: "app/routes/orders.py:10", confidence: "certain" },
      { name: "odd, name", where: "app/x.py:3", confidence: "inferred" },
    ]);
    assert.deepEqual(toonTable(text, "transitiveCallers"), []);
    assert.deepEqual(toonTable(text, "absent"), []);
  });

  test("evidence matches whether it sits in a quoted cell or in raw source", () => {
    const toon = 'gaps[1]{at,reason}:\n  x.ts:7,"fetch(""/api/orders"", {"';
    assert.ok(searchable(toon).includes('fetch("/api/orders", {'));
    const source = 'source:\n  const r = await fetch("/api/orders", {';
    assert.ok(searchable(source).includes('fetch("/api/orders"'));
  });

  test("JSON responses are searched by their decoded string values", () => {
    const json = JSON.stringify({ a: ['raise PaymentDeclined("x")'], b: { c: 1 } });
    assert.ok(searchable(json).includes('raise PaymentDeclined("x")'));
  });
});

describe("edges a response asserts", () => {
  const roots = [{ name: "web", root: "web" }, { name: "api", root: "api" }];
  const files = new Set([
    "web/src/api/orders.ts", "web/src/pages/Checkout.tsx",
    "api/app/routes/orders.py", "api/app/services/order_service.py",
  ]);

  test("a repo-relative path maps to the one workspace path that exists", () => {
    assert.equal(workspaceFile("src/api/orders.ts", roots, files), "web/src/api/orders.ts");
    assert.equal(workspaceFile("app/routes/orders.py", roots, files), "api/app/routes/orders.py");
    assert.equal(workspaceFile("nowhere.py", roots, files), null);
    const both = new Set(["web/x.ts", "api/x.ts"]);
    assert.equal(workspaceFile("x.ts", roots, both), null, "ambiguous is not guessed");
  });

  test("impact: each direct caller is an edge into the seed", () => {
    const text = [
      "symbol: submitOrder",
      "file: src/api/orders.ts",
      "directCallers[2]{name,where,confidence}:",
      "  onPay,src/pages/Checkout.tsx:4,certain",
      "  Checkout,src/pages/Checkout.tsx:3,certain",
      "transitiveCallers[1]{name,depth,confidence}:",
      "  deep,2,certain",
    ].join("\n");
    assert.deepEqual(edgesIn("impact", text, roots, files), [
      ["web/src/pages/Checkout.tsx::onPay", "web/src/api/orders.ts::submitOrder"],
      ["web/src/pages/Checkout.tsx::Checkout", "web/src/api/orders.ts::submitOrder"],
    ]);
  });

  test("impact: a not-found answer asserts no edges", () => {
    const text = "error: no symbol named create_order\ncandidates[0]:";
    assert.deepEqual(edgesIn("impact", text, roots, files), []);
  });

  test("context_pack: CALLS callees and callers count, CALLS_EXTERNAL does not", () => {
    const text = [
      "seed: submitOrder",
      "key: scip-typescript npm web 1 src/api/`orders.ts`/submitOrder().",
      "file: src/api/orders.ts",
      "callees[1]{name,detail,where}:",
      "  npm:fetch,CALLS_EXTERNAL [inferred],",
      "callers[1]{name,detail,where}:",
      '  onPay,"CALLS [certain] function onPay(): Promise<void>",src/pages/Checkout.tsx:4',
      "",
      "source:",
      "export async function submitOrder() {}",
    ].join("\n");
    assert.deepEqual(edgesIn("context_pack", text, roots, files), [
      ["web/src/pages/Checkout.tsx::onPay", "web/src/api/orders.ts::submitOrder"],
    ]);
  });

  test("other tools assert no edges", () => {
    assert.deepEqual(edgesIn("security_path", "coverage[0]:", roots, files), []);
    assert.deepEqual(edgesIn("endpoint_flow", "error: no route", roots, files), []);
  });
});

describe("scoring one question", () => {
  const question: GoldenQuestion = {
    id: "q",
    question: "?",
    facts: [
      { id: "f1", file: "a.py", line: 1, evidence: 'raise X("' },
      { id: "f2", file: "b.py", line: 2, evidence: "never shown" },
      { id: "f3", file: "b.py", line: 5, evidence: "also never" },
    ],
    expected_edges: [["a.py::f", "a.py::g"], ["a.py::f", "b.py::h"]],
  };
  const step = (bytes: number): StepRecord => ({
    tool: "impact", target: "f", bytes, raw_bytes: bytes + 10, error: false, ms: 1,
  });
  const cost: Record<string, number> = { "a.py": 100, "b.py": 40 };

  test("facts, fallback, baseline, precision and recall follow the original", () => {
    const r = scoreQuestion({
      question,
      steps: [step(30), step(12)],
      texts: ['... raise X("boom") ...'],
      returned: new Set([edgeKey(["a.py::f", "a.py::g"]), edgeKey(["a.py::f", "a.py::zzz"])]),
      trueEdges: new Set([edgeKey(["a.py::f", "a.py::g"]), edgeKey(["a.py::f", "b.py::h"])]),
      fileCost: (f) => cost[f]!,
    });
    assert.equal(r.graph_bytes, 42);
    assert.equal(r.facts_total, 3);
    assert.deepEqual(r.facts_covered, ["f1"]);
    assert.deepEqual(r.facts_missing, ["f2 (b.py:2)", "f3 (b.py:5)"]);
    assert.equal(r.fallback_bytes, 40, "a file still to read is counted once");
    assert.equal(r.total_bytes, 82);
    assert.equal(r.baseline_bytes, 140);
    assert.equal(r.edges_returned, 2);
    assert.deepEqual(r.false_edges, ["a.py::f -> a.py::zzz"]);
    assert.equal(r.expected_edges, 2);
    assert.deepEqual(r.expected_found, ["a.py::f -> a.py::g"]);
    assert.deepEqual(r.expected_missing, ["a.py::f -> b.py::h"]);
  });

  test("a question with no facts reads nothing and costs only its graph bytes", () => {
    const r = scoreQuestion({
      question: { id: "e", question: "?", facts: [] },
      steps: [step(5)],
      texts: [""],
      returned: new Set(),
      trueEdges: new Set(),
      fileCost: () => { throw new Error("must not read"); },
    });
    assert.equal(r.total_bytes, 5);
    assert.equal(r.baseline_bytes, 0);
    assert.equal(r.expected_edges, 0);
  });

  test("the report prints the ratio, misses and false edges", () => {
    const r = scoreQuestion({
      question,
      steps: [step(30)],
      texts: ['raise X("'],
      returned: new Set([edgeKey(["a.py::f", "a.py::zzz"])]),
      trueEdges: new Set(),
      fileCost: (f) => cost[f]!,
    });
    const out = formatReport([r], 2048, "code-intel mcp");
    assert.match(out, /tool schema \(tools\/list\): 2,048 B \(~512 tokens/);
    assert.match(out, /facts from graph: 1\/3/);
    assert.match(out, /graph 30 B \+ still-to-read 40 B = 70 B \(~18 tok\)/);
    assert.match(out, /vs reading files 140 B \(~35 tok\)\s+-> x0\.50/);
    assert.match(out, /missing: f2 \(b\.py:2\)/);
    assert.match(out, /FALSE: a\.py::f -> a\.py::zzz/);
    assert.match(out, /not found: a\.py::f -> a\.py::g/);
  });
});
