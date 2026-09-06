// CALLS derivation (task P0-T6).
//
// The call-site check is the single filter that took the false-positive rate
// from ~83% to 0% (docs/measurements.md M3), so it carries the most tests.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isCallSite, deriveCalls, dedupe, type SourceProvider } from "../src/derive/calls.ts";
import type { ScipIndex, ScipRange } from "../src/static/scip/reader.ts";
import { ROLE_DEFINITION, ROLE_IMPORT } from "../src/static/scip/reader.ts";

/** Range covering `needle` on line 0 of `line`. */
function rangeOf(line: string, needle: string): ScipRange {
  const start = line.indexOf(needle);
  assert.notEqual(start, -1, `"${needle}" not in "${line}"`);
  return { startLine: 0, startChar: start, endLine: 0, endChar: start + needle.length };
}

function check(line: string, needle: string): boolean | null {
  return isCallSite([line], rangeOf(line, needle));
}

describe("isCallSite — accepts real calls", () => {
  const cases: Array<[string, string]> = [
    ["const t = getToken();", "getToken"],
    ["await api.get(\"/api/v1/po\");", "get"],
    ["const x = request<T>(path);", "request"],
    ["foo ();", "foo"],
    ["new Date();", "Date"],
    ["items.map(x => x);", "map"],
    ["e.preventDefault();", "preventDefault"],
    ["useState<string[]>([]);", "useState"],
  ];
  for (const [line, needle] of cases) {
    test(`${needle} in ${JSON.stringify(line)}`, () => {
      assert.equal(check(line, needle), true);
    });
  }

  test("accepts a call whose parenthesis is on the next line", () => {
    assert.equal(isCallSite(["const x = doThing", "  (arg);"], rangeOf("const x = doThing", "doThing")), true);
  });
});

describe("isCallSite — rejects the false positives that drove the 83% rate", () => {
  const cases: Array<[string, string, string]> = [
    ["<div className=\"x\">", "div", "JSX intrinsic element"],
    ["<input value={v} />", "value", "JSX attribute"],
    ["<label htmlFor=\"a\">", "htmlFor", "JSX attribute"],
    ["const B = process.env.API;", "process", "property read"],
    ["if (res.ok) return;", "ok", "property read"],
    ["const { schema, data } = props;", "schema", "destructuring"],
    ["export type Column = { key: string };", "key", "type member"],
    ["const n = a < b;", "a", "less-than is not a generic call"],
  ];
  for (const [line, needle, why] of cases) {
    test(`${why}: ${needle}`, () => {
      assert.equal(check(line, needle), false);
    });
  }
});

describe("isCallSite — edge cases", () => {
  test("returns null when the line is out of range", () => {
    assert.equal(isCallSite([], { startLine: 5, startChar: 0, endLine: 5, endChar: 3 }), null);
  });

  test("identifier at end of file is not a call", () => {
    assert.equal(check("const x = foo", "foo"), false);
  });

  test("nested generics still resolve to a call", () => {
    assert.equal(check("f<Map<string, number>>(x);", "f"), true);
  });
});

// ---------------------------------------------------------------------------
// deriveCalls
// ---------------------------------------------------------------------------

const PKG = "scip-typescript npm demo 1.0.0 ";
const MODULE = PKG + "`a.ts`/";
const CALLER = PKG + "`a.ts`/caller().";
const CALLEE = PKG + "`a.ts`/callee().";
const TYPE = PKG + "`a.ts`/Shape#";

const SOURCE_LINES = [
  "export function callee() { return 1; }",   // line 1
  "export function caller() {",               // line 2
  "  const s: Shape = { n: callee() };",      // line 3
  "  const f = callee;",                      // line 4 — reference, NOT a call
  "  return s;",                              // line 5
  "}",                                        // line 6
];
const SOURCE = SOURCE_LINES.join("\n");

/**
 * Locate `needle` on a 0-based line and return its range.
 *
 * Hand-counted column offsets were wrong on the first attempt, and the
 * call-site check correctly rejected the result — so offsets are computed from
 * the source here rather than written by hand.
 */
function at(line: number, needle: string): ScipRange {
  const text = SOURCE_LINES[line]!;
  const start = text.indexOf(needle);
  assert.notEqual(start, -1, `"${needle}" not on line ${line}: ${text}`);
  return { startLine: line, startChar: start, endLine: line, endChar: start + needle.length };
}

/** The call to callee() on line 3 — the position every extra occurrence reuses. */
const CALL_POS = () => at(2, "callee");

function fakeIndex(): ScipIndex {
  return {
    projectRoot: "",
    toolName: "scip-typescript",
    toolVersion: "0.4.0",
    externalSymbols: [],
    documents: [{
      relativePath: "a.ts",
      language: "TypeScript",
      symbols: [],
      occurrences: [
        // definitions, with bodies
        { symbol: MODULE, range: { startLine: 0, startChar: 0, endLine: 0, endChar: 1 },
          symbolRoles: ROLE_DEFINITION, syntaxKind: 0,
          enclosingRange: { startLine: 0, startChar: 0, endLine: 5, endChar: 1 } },
        { symbol: CALLEE, range: at(0, "callee"),
          symbolRoles: ROLE_DEFINITION, syntaxKind: 0,
          enclosingRange: { startLine: 0, startChar: 0, endLine: 0, endChar: 37 } },
        { symbol: CALLER, range: at(1, "caller"),
          symbolRoles: ROLE_DEFINITION, syntaxKind: 0,
          enclosingRange: { startLine: 1, startChar: 0, endLine: 5, endChar: 1 } },
        // a real call to callee() on line 3
        { symbol: CALLEE, range: CALL_POS(), symbolRoles: 0, syntaxKind: 0, enclosingRange: null },
        // a TYPE reference on the same line — must not become a call
        { symbol: TYPE, range: at(2, "Shape"), symbolRoles: 0, syntaxKind: 0, enclosingRange: null },
        // callee passed by reference on line 4. The descriptor filters CANNOT
        // reject this — it is a method descriptor, identical to a real call.
        // Only the call-site check catches it.
        { symbol: CALLEE, range: at(3, "callee"), symbolRoles: 0, syntaxKind: 0, enclosingRange: null },
      ],
    }],
  };
}

const sources: SourceProvider = { text: (p) => (p === "a.ts" ? SOURCE : null) };

describe("deriveCalls", () => {
  test("emits the real call and attributes it to the innermost body", () => {
    const { calls } = deriveCalls(fakeIndex(), { sources });
    const real = calls.filter((c) => c.dstSymbol === CALLEE);
    assert.equal(real.length, 1, "exactly one CALLS edge");
    assert.equal(real[0]!.srcSymbol, CALLER, "attributed to caller(), not the module");
    assert.equal(real[0]!.line, 3);
    assert.equal(real[0]!.confidence, "certain", "target is defined in this index");
  });

  test("a type reference is not a call (R16)", () => {
    const { calls, stats } = deriveCalls(fakeIndex(), { sources });
    assert.equal(calls.some((c) => c.dstSymbol === TYPE), false);
    assert.ok((stats.skipped["typePosition"] ?? 0) >= 1);
  });

  test("import occurrences are skipped", () => {
    const index = fakeIndex();
    index.documents[0]!.occurrences.push({
      symbol: PKG + "`b.ts`/thing().",
      range: CALL_POS(),
      symbolRoles: ROLE_IMPORT, syntaxKind: 0, enclosingRange: null,
    });
    const { stats } = deriveCalls(index, { sources });
    assert.ok((stats.skipped["import"] ?? 0) >= 1);
  });

  test("local symbols are skipped — they have no stable identity", () => {
    const index = fakeIndex();
    index.documents[0]!.occurrences.push({
      symbol: "local 7",
      range: CALL_POS(),
      symbolRoles: 0, syntaxKind: 0, enclosingRange: null,
    });
    const { stats } = deriveCalls(index, { sources });
    assert.ok((stats.skipped["local"] ?? 0) >= 1);
  });

  test("without the call-site check, the type reference leaks through", () => {
    // Guards the finding: descriptor filters alone are not sufficient. Disabling
    // sources must NOT silently look identical to having them.
    const withCheck = deriveCalls(fakeIndex(), { sources }).calls;
    const without = deriveCalls(fakeIndex(), { sources: null }).calls;

    const line4 = (cs: typeof withCheck) => cs.filter((c) => c.line === 4).length;
    assert.equal(line4(withCheck), 0, "callee passed by reference is not a call");
    assert.equal(line4(without), 1, "without the check it leaks through as a false positive");
    assert.ok(without.length > withCheck.length);
  });

  test("an external target is inferred, not certain (R17)", () => {
    const index = fakeIndex();
    index.documents[0]!.occurrences.push({
      symbol: "scip-typescript npm react 18.3.1 `index.d.ts`/useState().",
      range: CALL_POS(),
      symbolRoles: 0, syntaxKind: 0, enclosingRange: null,
    });
    const { calls } = deriveCalls(index, { sources, localPackages: new Set(["demo"]) });
    const ext = calls.find((c) => c.dstSymbol.includes("react"));
    assert.ok(ext, "external call emitted");
    assert.equal(ext.confidence, "inferred");
  });

  test("dedupe collapses identical src/dst/file/line rows", () => {
    const one = {
      srcSymbol: "a", dstSymbol: "b", filePath: "f.ts", line: 1, col: 0,
      confidence: "certain" as const, fromModuleScope: false,
    };
    assert.equal(dedupe([one, { ...one }, { ...one, line: 2 }]).length, 2);
  });
});
