// SCIP symbol grammar parser (task P0-T6).
//
// Every symbol string below was taken verbatim from the real
// 60-kri-next.scip index, not invented. See docs/measurements.md M1.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseSymbol, symbolKind, displayNameOf, containerOf, packageOf,
  isTypePosition, isCallableTarget, isContainer, isParameterLike,
} from "../src/static/scip/symbol.ts";

const PKG = "scip-typescript npm 60-kri-next 0.1.0 ";

const FN = PKG + "lib/`api.ts`/request().";
const TYPE = PKG + "lib/`api.ts`/ApiEnvelope#";
const TYPE_PARAM = PKG + "lib/`api.ts`/ApiEnvelope#[T]";
const META = PKG + "lib/`api.ts`/ApiEnvelope#typeLiteral0:status.";
const MODULE = PKG + "`next-env.d.ts`/";
const TERM = PKG + "lib/`auth.tsx`/useAuth.";

describe("parseSymbol", () => {
  test("splits scheme, package and version from the descriptor run", () => {
    const p = parseSymbol(FN);
    assert.equal(p.scheme, "scip-typescript");
    assert.equal(p.manager, "npm");
    assert.equal(p.packageName, "60-kri-next");
    assert.equal(p.version, "0.1.0");
    assert.equal(p.isLocal, false);
  });

  test("unescapes backticked names containing punctuation", () => {
    const p = parseSymbol(FN);
    const names = p.descriptors.map((d) => d.name);
    assert.ok(names.includes("api.ts"), `expected api.ts in ${JSON.stringify(names)}`);
    assert.ok(!names.some((n) => n.includes("`")), "no backticks should survive");
  });

  test("recognises a local symbol", () => {
    const p = parseSymbol("local 12");
    assert.equal(p.isLocal, true);
    assert.equal(p.descriptors[0]?.kind, "local");
    assert.equal(p.descriptors[0]?.name, "12");
  });

  test("an empty symbol does not throw", () => {
    assert.doesNotThrow(() => parseSymbol(""));
    assert.equal(parseSymbol("").descriptors.length, 0);
  });

  test("a malformed symbol does not throw or hang", () => {
    for (const bad of ["nonsense", "a b c", "scip x y z `unterminated", PKG + "((("]) {
      assert.doesNotThrow(() => parseSymbol(bad), `should tolerate ${JSON.stringify(bad)}`);
    }
  });
});

describe("symbolKind — the only kind discriminator available (M1)", () => {
  test("classifies each descriptor form from real index data", () => {
    assert.equal(symbolKind(FN), "method");
    assert.equal(symbolKind(TYPE), "type");
    assert.equal(symbolKind(TYPE_PARAM), "typeParameter");
    assert.equal(symbolKind(TERM), "term");
    assert.equal(symbolKind(MODULE), "namespace");
    assert.equal(symbolKind(META), "term", "trailing '.' wins over the ':' meta segment");
  });
});

describe("displayNameOf — replaces the empty displayName field", () => {
  test("takes the trailing descriptor name", () => {
    assert.equal(displayNameOf(FN), "request");
    assert.equal(displayNameOf(TYPE), "ApiEnvelope");
    assert.equal(displayNameOf(TERM), "useAuth");
  });

  test("falls back through the chain when the tail is anonymous", () => {
    assert.equal(displayNameOf(MODULE), "next-env.d.ts");
  });

  test("returns the raw symbol when nothing is parseable", () => {
    assert.equal(displayNameOf("garbage"), "garbage");
  });
});

describe("containerOf", () => {
  test("joins the enclosing descriptor chain", () => {
    assert.equal(containerOf(FN), "lib/api.ts");
    assert.equal(containerOf(TYPE_PARAM), "lib/api.ts/ApiEnvelope");
  });
});

describe("R16 filters", () => {
  test("type positions are excluded from CALLS", () => {
    assert.equal(isTypePosition(TYPE), true, "ApiEnvelope# is a type reference");
    assert.equal(isTypePosition(TYPE_PARAM), true, "[T] is a type parameter");
    assert.equal(isTypePosition(FN), false, "request(). is a call");
    assert.equal(isTypePosition(TERM), false);
  });

  test("callable targets are methods and terms", () => {
    assert.equal(isCallableTarget(FN), true);
    assert.equal(isCallableTarget(TERM), true, "a const may hold a function");
    assert.equal(isCallableTarget(TYPE), false);
    assert.equal(isCallableTarget(MODULE), false);
  });

  test("containers and parameters are never call targets", () => {
    assert.equal(isContainer(MODULE), true);
    assert.equal(isParameterLike(PKG + "lib/`api.ts`/request().(path)"), true);
  });

  test("a method on a type is callable, the type itself is not", () => {
    // The distinction the whole filter rests on: only the TRAILING descriptor
    // decides. Foo# is a type; Foo#bar(). is a call on it.
    const method = PKG + "lib/`api.ts`/ApiEnvelope#toJSON().";
    assert.equal(isCallableTarget(method), true);
    assert.equal(isTypePosition(method), false);
    assert.equal(isTypePosition(TYPE), true);
  });
});

describe("packageOf", () => {
  test("identifies the owning package, for local vs dependency confidence", () => {
    assert.equal(packageOf(FN), "60-kri-next");
    assert.equal(packageOf("scip-typescript npm react 18.3.1 `index.d.ts`/useState()."), "react");
  });
});
