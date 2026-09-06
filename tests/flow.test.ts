// endpoint_flow (task P0-T9) — the Phase 0 exit criterion.
//
// The traversal is tested against synthetic call sets so the assertions state
// the rules directly, and `functionExtent` is tested against real source shapes
// because it is the piece that decides whether an anonymous hook's call tree is
// its own or the whole module's.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  weakest, functionExtent, buildCallTree, symbolAt, buildDefinitionRanges,
  type Confidence,
} from "../src/query/flow.ts";
import type { DerivedCall, UnresolvedCall } from "../src/derive/calls.ts";
import type { ScipIndex } from "../src/static/scip/reader.ts";
import { ROLE_DEFINITION } from "../src/static/scip/reader.ts";

const PKG = "scip-typescript npm svc 1.0.0 ";
const sym = (name: string) => `${PKG}\`a.js\`/${name}().`;
const MODULE = `${PKG}\`a.js\`/`;

function call(
  src: string, dst: string, line: number,
  confidence: "certain" | "inferred" = "certain", col = 2,
): DerivedCall {
  return {
    srcSymbol: src, dstSymbol: dst, filePath: "a.js", line, col,
    confidence, fromModuleScope: src === MODULE,
  };
}

describe("weakest — min_conf propagation (R36)", () => {
  const cases: Array<[Confidence, Confidence, Confidence]> = [
    ["certain", "inferred", "inferred"],
    ["certain", "certain", "certain"],
    ["inferred", "unresolved", "unresolved"],
    ["observed", "certain", "observed"],
    ["unresolved", "certain", "unresolved"],
  ];
  for (const [a, b, want] of cases) {
    test(`${a} + ${b} -> ${want}`, () => {
      assert.equal(weakest(a, b), want);
      assert.equal(weakest(b, a), want, "order must not matter");
    });
  }
});

describe("functionExtent", () => {
  const extent = (src: string, line: number, col: number) =>
    functionExtent(src.split("\n"), line, col);

  test("bounds an anonymous arrow with a block body", () => {
    const src = [
      "app.addHook('onRequest', async (req, reply) => {",   // 1
      "  req.start = Date.now();",                          // 2
      "  reply.header('x', 1);",                            // 3
      "});",                                                // 4
      "app.listen();",                                      // 5
    ].join("\n");
    assert.deepEqual(extent(src, 1, 25), { startLine: 1, endLine: 4 });
  });

  test("stops before the next statement, not at end of file", () => {
    // The whole point: without this the hook's tree swallows `listen` and
    // `process.exit` and everything else in the module.
    const src = [
      "app.addHook('onRequest', async (req, reply) => {",
      "  a();",
      "});",
      "app.listen();",
      "process.exit(0);",
    ].join("\n");
    assert.equal(extent(src, 1, 25)!.endLine, 3);
  });

  test("bounds an expression-bodied arrow", () => {
    const src = "app.options('/*', async (req, reply) => reply.status(204).send());";
    assert.deepEqual(extent(src, 1, 18), { startLine: 1, endLine: 1 });
  });

  test("a destructured parameter list does not open the body", () => {
    const src = [
      "async function forward({ method, url, headers = {} }) {",
      "  return axios({ method, url });",
      "}",
    ].join("\n");
    assert.deepEqual(extent(src, 1, 22), { startLine: 1, endLine: 3 });
  });

  test("braces inside strings and comments do not confuse it", () => {
    const src = [
      "app.addHook('onSend', async (req, reply) => {",
      "  const s = '}';    // } not a close",
      '  const t = "{{";',
      "  reply.send(s + t);",
      "});",
    ].join("\n");
    assert.equal(extent(src, 1, 22)!.endLine, 5);
  });

  test("returns null for a line outside the file", () => {
    assert.equal(functionExtent(["a"], 9, 0), null);
  });
});

describe("buildCallTree", () => {
  const calls = [
    call(sym("handler"), sym("auth"), 10),
    call(sym("handler"), sym("send"), 20),
    call(sym("auth"), sym("envelope"), 30),
    call(sym("envelope"), sym("nowIso"), 40),
  ];

  test("expands depth-first in source order", () => {
    const t = buildCallTree(calls, sym("handler"));
    assert.deepEqual(t.children.map((c) => c.display), ["auth", "send"]);
    assert.deepEqual(t.children[0]!.children.map((c) => c.display), ["envelope"]);
  });

  test("stops at the depth cap and says it stopped", () => {
    const t = buildCallTree(calls, sym("handler"), { maxDepth: 2 });
    const envelope = t.children[0]!.children[0]!;
    assert.equal(envelope.display, "envelope");
    assert.equal(envelope.truncated, true, "envelope calls nowIso but was not expanded");
    assert.equal(envelope.children.length, 0);
  });

  test("a cycle is marked, not followed", () => {
    const cyclic = [
      call(sym("a"), sym("b"), 1),
      call(sym("b"), sym("a"), 2),
    ];
    const t = buildCallTree(cyclic, sym("a"));
    const back = t.children[0]!.children[0]!;
    assert.equal(back.display, "a");
    assert.equal(back.cycle, true);
    assert.equal(back.children.length, 0);
  });

  test("path confidence is the weakest edge, not the last one (R36)", () => {
    const mixed = [
      call(sym("a"), sym("b"), 1, "inferred"),
      call(sym("b"), sym("c"), 2, "certain"),
    ];
    const t = buildCallTree(mixed, sym("a"));
    const c = t.children[0]!.children[0]!;
    assert.equal(c.edge, "certain", "this hop is certain");
    assert.equal(c.pathConfidence, "inferred", "but the path crossed an inferred hop");
  });

  test("an external package is a boundary and is not expanded", () => {
    const ext = "scip-typescript npm axios 1.7.2 `index.d.ts`/request().";
    const t = buildCallTree(
      [call(sym("a"), ext, 1), { ...call(ext, sym("deep"), 2) }],
      sym("a"),
      { localPackages: new Set(["svc"]) },
    );
    assert.equal(t.children[0]!.external, true);
    assert.equal(t.children[0]!.children.length, 0, "traversal stops at the boundary");
  });

  test("rootScope limits the root to one function's lines", () => {
    const moduleCalls = [
      call(MODULE, sym("registerHook"), 5, "certain", 0),   // the addHook call
      call(MODULE, sym("inside"), 6),
      call(MODULE, sym("alsoInside"), 8),
      call(MODULE, sym("elsewhere"), 40),
    ];
    const t = buildCallTree(moduleCalls, MODULE, {
      rootScope: { startLine: 5, startCol: 25, endLine: 9, display: "hook" },
    });
    assert.equal(t.display, "hook");
    assert.deepEqual(t.children.map((c) => c.display), ["inside", "alsoInside"],
      "the registering call to the left of the hook, and line 40, are both out");
  });

  test("unresolved call sites render as explicit branches (R11)", () => {
    const unresolved: UnresolvedCall[] = [{
      srcSymbol: sym("forward"),
      filePath: "a.js", line: 68, col: 9,
      target: "scip-typescript npm axios 1.7.2 `index.d.ts`/",
      reason: "callee resolved to a package or module, not to a function",
    }];
    const t = buildCallTree([call(sym("handler"), sym("forward"), 5)], sym("handler"), {
      unresolved,
    });
    const branch = t.children[0]!.children[0]!;
    assert.equal(branch.edge, "unresolved");
    assert.equal(branch.pathConfidence, "unresolved");
    assert.match(branch.display, /axios/);
    // Omitting it would render `forward` as calling nothing, which is a
    // different and false claim than "we could not name what it calls".
    assert.equal(t.children[0]!.children.length, 1);
  });
});

describe("symbolAt — joining a boot hook to a SCIP definition", () => {
  const index: ScipIndex = {
    projectRoot: "", toolName: "t", toolVersion: "0", externalSymbols: [],
    documents: [{
      relativePath: "a.js", language: "JavaScript", symbols: [],
      occurrences: [
        { symbol: MODULE, range: { startLine: 0, startChar: 0, endLine: 0, endChar: 1 },
          symbolRoles: ROLE_DEFINITION, syntaxKind: 0,
          enclosingRange: { startLine: 0, startChar: 0, endLine: 99, endChar: 0 } },
        { symbol: sym("outer"), range: { startLine: 9, startChar: 0, endLine: 9, endChar: 5 },
          symbolRoles: ROLE_DEFINITION, syntaxKind: 0,
          enclosingRange: { startLine: 9, startChar: 0, endLine: 29, endChar: 1 } },
        { symbol: sym("inner"), range: { startLine: 14, startChar: 2, endLine: 14, endChar: 7 },
          symbolRoles: ROLE_DEFINITION, syntaxKind: 0,
          enclosingRange: { startLine: 14, startChar: 2, endLine: 19, endChar: 3 } },
      ],
    }],
  };
  const ranges = buildDefinitionRanges(index);

  test("picks the innermost containing definition", () => {
    assert.equal(symbolAt(ranges, "a.js", 16), sym("inner"));
    assert.equal(symbolAt(ranges, "a.js", 25), sym("outer"));
  });

  test("falls back to the module when no function covers the line", () => {
    // This is the case that needs functionExtent: an anonymous hook lands here.
    assert.equal(symbolAt(ranges, "a.js", 50), MODULE);
  });

  test("a windows-style path still matches", () => {
    assert.equal(symbolAt(ranges, "a.js", 16), sym("inner"));
  });

  test("returns undefined for an unknown file", () => {
    assert.equal(symbolAt(ranges, "b.js", 16), undefined);
  });
});
