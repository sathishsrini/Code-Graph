// Tests for the reviewed feature manifest (task P3-T8, R81).
//
// The property that matters is verbatim round-tripping. Entries are node keys
// copied from the graph — SCIP symbols carry backticks, spaces and
// parentheses; route keys carry spaces and slashes — and a parser that mangles
// one character produces a manifest entry that silently resolves to nothing.
// `check-kinds.yml`'s value charset (`[A-Za-z0-9_$.-]+`) rejects every one of
// these, which is why this file has its own reader rather than sharing that
// one.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFeatures, matchFeature } from "../src/config/features.ts";

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), "code-intel-features-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

let n = 0;
function manifest(body: string): ReturnType<typeof loadFeatures> {
  const path = join(dir, `f${n++}.yml`);
  writeFileSync(path, body, "utf8");
  return loadFeatures(path);
}

const SCIP = "scip-typescript npm 60-kri-next 0.1.0 app/grn/`page.tsx`/GRNPage().";

describe("parsing the manifest", () => {
  test("a SCIP symbol round-trips verbatim, backticks and parens included", () => {
    const m = manifest(
      `features:\n  grn-creation:\n    name: GRN creation\n    symbols:\n      - ${SCIP}\n`,
    );
    const entry = m.features[0]!.entries[0]!;
    assert.equal(entry.spec, SCIP, "byte-for-byte, or resolveSeed finds nothing");
    assert.equal(entry.kind, "symbol");
  });

  test("a route key round-trips with its spaces and slashes", () => {
    const m = manifest(
      "features:\n  grn-creation:\n    routes:\n      - 40-kri-router POST /api/v1/grn/:id\n",
    );
    assert.equal(m.features[0]!.entries[0]!.spec, "40-kri-router POST /api/v1/grn/:id");
    assert.equal(m.features[0]!.entries[0]!.kind, "route");
  });

  test("declaration order is preserved — it is seed priority", () => {
    const m = manifest(
      "features:\n  f:\n    routes:\n      - a GET /1\n      - a GET /2\n" +
      "    symbols:\n      - sym().\n",
    );
    assert.deepEqual(
      m.features[0]!.entries.map((e) => e.spec), ["a GET /1", "a GET /2", "sym()."],
    );
  });

  test("every entry carries the line that declared it", () => {
    // `features check` points at a row to fix. A stale entry with no line
    // number is a bug report without a location.
    const m = manifest("features:\n  f:\n    routes:\n      - a GET /1\n");
    assert.equal(m.features[0]!.entries[0]!.line, 4);
  });

  test("name and notes are read; the id is the fallback name", () => {
    const m = manifest(
      "features:\n  grn-creation:\n    notes: the router special-cases this\n",
    );
    assert.equal(m.features[0]!.name, "grn-creation", "id stands in for a missing name");
    assert.equal(m.features[0]!.notes, "the router special-cases this");
  });

  test("comments and blank lines are ignored", () => {
    const m = manifest(
      "# leading\nfeatures:\n\n  f:   # trailing\n    routes:\n      - a GET /1\n\n",
    );
    assert.equal(m.features.length, 1);
    assert.equal(m.features[0]!.entries[0]!.spec, "a GET /1");
  });

  test("a line the subset cannot parse throws with its number", () => {
    // Silently skipping a malformed row is how a manifest quietly gets smaller.
    assert.throws(
      () => manifest("features:\n  f:\n    routes:\n      * a GET /1\n"),
      /line 4/,
    );
  });

  test("a missing file is a state, not a failure", () => {
    // The pack falls back to search and says so. Throwing would make an
    // optional file mandatory.
    const m = loadFeatures(join(dir, "does-not-exist.yml"));
    assert.equal(m.present, false);
    assert.deepEqual(m.features, []);
  });
});

describe("matching a phrase to a feature", () => {
  // The name is deliberately NOT a re-spelling of the id here. In the shipped
  // manifest `grn-creation` and "GRN creation" normalise to the same tokens,
  // so the id arm answers first and `how: "name"` is unreachable — correct
  // behaviour, but it makes the two arms untestable from one fixture.
  const m = () => manifest(
    "features:\n  grn-creation:\n    name: Receipt capture\n    aliases:\n" +
    "      - goods receipt note\n      - create grn\n    routes:\n      - a POST /grn\n" +
    "  po-approval:\n    name: PO approval\n    routes:\n      - a POST /po\n",
  );

  test("the id, the name and an alias all match, and each says which", () => {
    const f = m();
    assert.equal(matchFeature(f, "grn-creation")?.how, "id");
    assert.equal(matchFeature(f, "Receipt capture")?.how, "name");
    assert.equal(matchFeature(f, "goods receipt note")?.how, "alias");
  });

  test("matching ignores case and punctuation", () => {
    const f = m();
    for (const phrase of ["GRN CREATION", "grn, creation", "  Grn   Creation  "]) {
      assert.equal(matchFeature(f, phrase)?.feature.id, "grn-creation", phrase);
    }
  });

  test("a phrase containing a label's tokens matches, and is labelled 'tokens'", () => {
    const hit = matchFeature(m(), "I need to change create grn today");
    assert.equal(hit?.feature.id, "grn-creation");
    assert.equal(hit?.how, "tokens", "a loose match must not claim to be exact");
  });

  test("the longest matching label wins, not the first declared", () => {
    const hit = matchFeature(m(), "goods receipt note handling");
    assert.equal(hit?.feature.id, "grn-creation");
  });

  test("an unmatched phrase is null, never a guess", () => {
    // A miss falls through to search and the pack says which answered. A wrong
    // match is invisible; a miss is not.
    assert.equal(matchFeature(m(), "invoice reconciliation"), null);
    assert.equal(matchFeature(m(), "!!!"), null);
  });

  test("the right feature is picked when two are declared", () => {
    assert.equal(matchFeature(m(), "PO approval")?.feature.id, "po-approval");
  });
});

describe("the shipped manifest", () => {
  test("rules/features.yml parses and every feature has at least one entry", () => {
    // A feature with no entry points resolves to an empty pack, which reads as
    // "this feature touches nothing" rather than "nobody filled this in".
    const m = loadFeatures("rules/features.yml");
    assert.equal(m.present, true);
    assert.ok(m.features.length > 0);
    for (const f of m.features) {
      assert.ok(f.entries.length > 0, `${f.id} declares no entry points`);
    }
  });
});
