// Tests for the workflow token benchmark's scoring (scripts/workflow-bench.ts).
//
// The bench's numbers are only worth quoting if the arithmetic behind them is
// pinned. These cover the pure half: byte accounting, fact matching, edge
// extraction from code-intel's TOON responses, and precision/recall. The half
// that drives the MCP server is exercised by running the bench itself.
//
// CTX-S2 adds: line-range reads (corpus mode's "reading the files"), the G5
// gate as a pure verdict, and the structure of tests/fixtures/corpus.golden.json.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TOOLS } from "../src/mcp/server.ts";
import {
  READ_GUTTER_BYTES, workspaceVariants, shorten, searchable, readCost, tokens,
  splitToonRow, toonScalar, toonTable, workspaceFile, edgesIn, edgeKey,
  scoreQuestion, formatReport, mergeRanges, readRangesCost, corpusPath, gate, formatGate,
  type StepRecord, type GoldenQuestion, type QuestionResult, type Fact, type LineRange,
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

// ---------------------------------------------------------------------------
// CTX-S2: line ranges. The gate charges whole files (owner, 2026-09-27); the
// cited lines are reported beside it for information only.
// ---------------------------------------------------------------------------

describe("reading line ranges (CTX-S2 corpus mode)", () => {
  test("ranges are sorted and merged when they overlap or touch", () => {
    assert.deepEqual(
      mergeRanges([[10, 12], [1, 3], [4, 5], [11, 20], [30, 30]]),
      [[1, 5], [10, 20], [30, 30]],
    );
    assert.deepEqual(mergeRanges([]), []);
  });

  test("a range read costs the Read accounting of exactly those lines", () => {
    const data = enc("a\nbb\nccc\ndddd\n");
    assert.equal(readRangesCost(data, [[2, 3]]), readCost(enc("bb\nccc\n")));
    assert.equal(readRangesCost(data, [[1, 4]]), readCost(data), "the whole file is the whole file");
    assert.equal(readRangesCost(data, [[3, 3], [1, 1]]), readCost(enc("a\nccc\n")));
    assert.equal(readRangesCost(data, [[2, 3], [3, 4]]), readCost(enc("bb\nccc\ndddd\n")), "overlap counted once");
    assert.equal(readRangesCost(enc("x\ny"), [[2, 2]]), 1, "a last line without a newline has no gutter, as readCost");
  });

  test("a range outside the file is an error, never clamped", () => {
    // A golden whose range runs past the end is out of date with the corpus;
    // clamping would quietly shrink the baseline the gate compares against.
    assert.throws(() => readRangesCost(enc("a\nb\n"), [[2, 3]]), /line 3.*2 lines/);
    assert.throws(() => readRangesCost(enc("a\n"), [[0, 1]]), /1-based/);
    assert.throws(() => readRangesCost(enc("a\nb\n"), [[2, 1]]), /start.*end/);
  });

  test("scoring charges whole files for the baseline and the fallback; the cited lines are only reported", () => {
    // G5 compares against "reading the files" (owner, 2026-09-27): without the
    // graph Claude reads the files, and a fact the graph missed sends it to the
    // file, not to a line range it has no way to know.
    const question: GoldenQuestion = {
      id: "r",
      question: "?",
      facts: [
        { id: "a", file: "s/x.js", line: 5, evidence: "SHOWN_A", ranges: [[5, 9]] },
        { id: "b", file: "s/x.js", line: 20, evidence: "HIDDEN_B", ranges: [[20, 22]] },
        { id: "c", file: "s/x.js", line: 8, evidence: "HIDDEN_C", ranges: [[8, 12]] },
        { id: "d", file: "t/y.py", line: 3, evidence: "SHOWN_D", ranges: [[3, 3]] },
      ],
    };
    const seen: string[] = [];
    // Cost = number of lines asked for, or 1000 for a whole file.
    const fileCost = (file: string, ranges?: readonly LineRange[]): number => {
      seen.push(`${file} ${JSON.stringify(ranges ?? null)}`);
      return ranges ? ranges.reduce((n, [s, e]) => n + e - s + 1, 0) : 1000;
    };
    const r = scoreQuestion({
      question,
      steps: [{ tool: "impact", target: "x", bytes: 4, raw_bytes: 4, error: false, ms: 1 }],
      texts: ["SHOWN_A SHOWN_D"],
      returned: new Set(),
      trueEdges: new Set(),
      fileCost,
    });
    assert.deepEqual(r.facts_missing, ["b (s/x.js:20)", "c (s/x.js:8)"]);
    assert.equal(r.baseline_bytes, 2000, "x.js and y.py, whole");
    assert.equal(r.fallback_bytes, 1000, "x.js, whole: the file of the missing facts, counted once");
    assert.equal(r.total_bytes, 4 + 1000);
    assert.equal(r.baseline_cited_bytes, 8 + 3 + 1, "x.js [5-12]+[20-22], y.py [3], for information");
    assert.ok(seen.includes("s/x.js [[5,12],[20,22]]"), seen.join(" | "));
  });

  test("a fact without ranges makes its whole file the read, as in the fixture bench", () => {
    const question: GoldenQuestion = {
      id: "w",
      question: "?",
      facts: [
        { id: "a", file: "x.js", line: 5, evidence: "NOPE", ranges: [[5, 9]] },
        { id: "b", file: "x.js", line: 20, evidence: "NOPE" },
      ],
    };
    const r = scoreQuestion({
      question, steps: [], texts: [""], returned: new Set(), trueEdges: new Set(),
      fileCost: (_f, ranges) => (ranges ? 1 : 1000),
    });
    assert.equal(r.baseline_bytes, 1000);
    assert.equal(r.fallback_bytes, 1000);
    assert.equal(r.baseline_cited_bytes, 1000, "a file with an unranged fact is cited whole");

    // An empty list is no ranges, not a free read.
    const empty = scoreQuestion({
      question: { id: "e", question: "?", facts: [{ id: "a", file: "x.js", line: 1, evidence: "NOPE", ranges: [] }] },
      steps: [], texts: [""], returned: new Set(), trueEdges: new Set(),
      fileCost: (_f, ranges) => (ranges ? 1 : 1000),
    });
    assert.equal(empty.baseline_bytes, 1000);
  });

  test("the fixture bench's results carry no cited-lines figure, so its report is unchanged", () => {
    const r = scoreQuestion({
      question: { id: "f", question: "?", facts: [{ id: "a", file: "x.py", line: 1, evidence: "E" }] },
      steps: [], texts: ["E"], returned: new Set(), trueEdges: new Set(), fileCost: () => 10,
    });
    assert.equal(r.baseline_cited_bytes, undefined);
    assert.doesNotMatch(formatReport([r], 0, "s"), /cited lines/);
  });

  test("the report prints the cited-lines figure beside the whole-file baseline", () => {
    const r = scoreQuestion({
      question: { id: "g", question: "?", facts: [{ id: "a", file: "x.js", line: 2, evidence: "E", ranges: [[2, 2]] }] },
      steps: [], texts: [""], returned: new Set(), trueEdges: new Set(),
      fileCost: (_f, ranges) => (ranges ? 40 : 4000),
    });
    assert.match(
      formatReport([r], 0, "s"),
      /vs reading files 4,000 B \(~1,000 tok\)\s+-> x1\.00\s+\(cited lines only 40 B, ~10 tok\)/,
    );
  });

  test("a corpus file is '<repo>/<path>' under that repo's rootPath from config/repos.json", () => {
    const repos = [
      { name: "40-kri-router", rootPath: "D:/ws/40-kri-router/" },
      { name: "51-integration", rootPath: "/srv/ws/51-integration" },
    ];
    assert.equal(corpusPath("40-kri-router/server.js", repos), "D:/ws/40-kri-router/server.js");
    assert.equal(corpusPath("51-integration/app/main.py", repos), "/srv/ws/51-integration/app/main.py");
    assert.equal(corpusPath("99-unknown/x.js", repos), null);
    assert.equal(corpusPath("server.js", repos), null, "no repo segment");
  });
});

// ---------------------------------------------------------------------------
// CTX-S2: the G5 gate
// ---------------------------------------------------------------------------

describe("the G5 gate (CTX-S2)", () => {
  const result = (
    id: string,
    o: { total: number; baseline: number; missing?: string[]; facts?: number },
  ): QuestionResult => ({
    id,
    steps: [],
    graph_bytes: o.total,
    facts_total: o.facts ?? 3,
    facts_covered: [],
    facts_missing: o.missing ?? [],
    fallback_bytes: 0,
    total_bytes: o.total,
    baseline_bytes: o.baseline,
    edges_returned: 0,
    false_edges: [],
    expected_edges: 0,
    expected_found: [],
    expected_missing: [],
  });

  test("passes when every question is cheaper than reading its files and has every fact", () => {
    const v = gate([result("q1", { total: 99, baseline: 100 }), result("q2", { total: 1, baseline: 5000 })]);
    assert.equal(v.pass, true);
    assert.deepEqual(v.failures, []);
    assert.match(formatGate(v), /GATE PASS/);
  });

  test("fails naming the question when graph + still-to-read is not lower (equal is not lower)", () => {
    for (const total of [100, 101]) {
      const v = gate([result("po_flow", { total, baseline: 100 })]);
      assert.equal(v.pass, false);
      assert.deepEqual(v.failures.map((f) => [f.question, f.condition]), [["po_flow", "tokens"]]);
      const text = formatGate(v);
      assert.match(text, /GATE FAIL/);
      assert.match(text, /po_flow\s+tokens: graph \+ still-to-read .* >= reading the files/);
    }
  });

  test("fails naming the fact when one is missing, even when tokens are lower", () => {
    const v = gate([result("edit", { total: 10, baseline: 100, missing: ["exempt_ready (40-kri-router/server.js:77)"] })]);
    assert.equal(v.pass, false);
    assert.deepEqual(v.failures, [{
      question: "edit", condition: "fact", detail: "exempt_ready (40-kri-router/server.js:77)",
    }]);
    assert.match(formatGate(v), /edit\s+fact missing: exempt_ready \(40-kri-router\/server\.js:77\)/);
  });

  test("one failing question among passing ones fails the gate, and only it is named", () => {
    const v = gate([
      result("a", { total: 1, baseline: 10 }),
      result("b", { total: 20, baseline: 10, missing: ["f1 (x:1)", "f2 (x:2)"] }),
      result("c", { total: 1, baseline: 10 }),
    ]);
    assert.equal(v.pass, false);
    assert.deepEqual(new Set(v.failures.map((f) => f.question)), new Set(["b"]));
    assert.deepEqual(v.failures.map((f) => f.condition), ["tokens", "fact", "fact"]);
    assert.match(formatGate(v), /1 of 3 questions fail/);
  });

  test("a question with no facts is not gated, and a run with nothing to gate does not pass", () => {
    // orders_app's order_call_chain is edges-only: it has no reading-the-files
    // baseline, so G5's two conditions say nothing about it.
    const mixed = gate([result("chain", { total: 50, baseline: 0, facts: 0 }), result("a", { total: 1, baseline: 10 })]);
    assert.equal(mixed.pass, true);
    assert.deepEqual(mixed.notGated, ["chain"]);
    assert.match(formatGate(mixed), /not gated \(no facts\): chain/);

    const empty = gate([result("chain", { total: 50, baseline: 0, facts: 0 })]);
    assert.equal(empty.pass, false, "a gate with nothing to judge must not pass");
    assert.deepEqual(empty.failures.map((f) => f.condition), ["empty"]);
  });
});

// ---------------------------------------------------------------------------
// CTX-S2: the corpus golden and its plans
// ---------------------------------------------------------------------------

describe("corpus golden (tests/fixtures/corpus.golden.json, CTX-S2)", () => {
  interface CorpusFact extends Fact { key: string; approx?: boolean; note?: string }
  interface CorpusQuestion { id: string; kind: string; question: string; facts: CorpusFact[] }
  interface CorpusPlanStep { tool: string; args: Record<string, unknown>; from: string; requires?: string }

  const ROOT = resolve(import.meta.dirname, "..");
  const read = (rel: string): unknown => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
  const golden = read("tests/fixtures/corpus.golden.json") as {
    corpus: string; provenance: string; questions: CorpusQuestion[];
  };
  const plans = read("tests/fixtures/corpus.plans.json") as {
    plans: Record<string, { steps: CorpusPlanStep[]; unmapped: unknown[] }>;
  };
  const repos = (read("config/repos.json") as { repos: Array<{ name: string; rootPath: string }> }).repos;
  const KINDS = ["endpoint_flow", "feature_by_description", "edit_context", "error_origin", "api_tables"];

  test("records its provenance: the answer keys of docs/ab-token-check.md, 2026-09-27", () => {
    assert.equal(golden.corpus, "config/repos.json");
    assert.match(golden.provenance, /docs\/ab-token-check\.md/);
    assert.match(golden.provenance, /2026-09-27/);
  });

  test("has at least 5 questions covering the five kinds, with unique ids", () => {
    assert.ok(golden.questions.length >= 5, `${golden.questions.length} questions`);
    assert.deepEqual([...new Set(golden.questions.map((q) => q.kind))].sort(), [...KINDS].sort());
    assert.equal(new Set(golden.questions.map((q) => q.id)).size, golden.questions.length);
  });

  test("every fact has evidence, a key fact, and a source file:line inside its ranges", () => {
    for (const q of golden.questions) {
      assert.ok(q.facts.length > 0, `${q.id} has no facts`);
      assert.equal(new Set(q.facts.map((f) => f.id)).size, q.facts.length, `${q.id}: duplicate fact id`);
      for (const f of q.facts) {
        const at = `${q.id}/${f.id}`;
        assert.ok(typeof f.evidence === "string" && f.evidence.trim() !== "", `${at}: evidence`);
        assert.match(f.key, /^Q[1-3]\.\d+$/, `${at}: key names an answer-key fact`);
        assert.ok(corpusPath(f.file, repos), `${at}: ${f.file} is not '<repo in config/repos.json>/<path>'`);
        assert.ok(Number.isInteger(f.line) && f.line > 0, `${at}: line`);
        assert.ok(Array.isArray(f.ranges) && f.ranges.length > 0, `${at}: ranges`);
        for (const [s, e] of f.ranges!) {
          assert.ok(Number.isInteger(s) && Number.isInteger(e) && s >= 1 && s <= e, `${at}: range ${s}-${e}`);
        }
        assert.ok(f.ranges!.some(([s, e]) => f.line >= s && f.line <= e), `${at}: line ${f.line} outside its ranges`);
        if (f.approx) assert.ok(f.note && /≈/.test(f.note), `${at}: an approximate line says so in its note`);
      }
    }
  });

  test("every question has a plan, every plan a question", () => {
    assert.deepEqual(Object.keys(plans.plans).sort(), golden.questions.map((q) => q.id).sort());
  });

  test("every plan step names an existing MCP tool, or is marked as waiting for the slice that adds it", () => {
    const existing = new Set<string>(TOOLS.map((t) => t.name));
    for (const [id, plan] of Object.entries(plans.plans)) {
      assert.ok(plan.steps.length > 0, `${id} has no steps`);
      for (const step of plan.steps) {
        assert.ok(typeof step.from === "string" && step.from !== "", `${id}: step without 'from'`);
        if (step.requires !== undefined) {
          assert.match(step.requires, /^CTX-S\d+$/, `${id}: ${step.tool} requires`);
        } else {
          assert.ok(existing.has(step.tool), `${id}: ${step.tool} is not a tool in src/mcp/server.ts and is not marked 'requires'`);
        }
      }
    }
  });

  test("no fact's evidence is in its own plan's arguments, where an echoed argument would credit it", () => {
    for (const q of golden.questions) {
      const args = JSON.stringify(plans.plans[q.id]?.steps.map((s) => s.args) ?? []);
      for (const f of q.facts) {
        assert.ok(!args.includes(f.evidence), `${q.id}/${f.id}: evidence "${f.evidence}" is in a plan argument`);
      }
    }
  });
});
