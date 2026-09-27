// Consistency tests for the orders_app golden (tests/fixtures/orders_app.golden.json).
//
// The golden is ground truth for a workflow benchmark. A fact counts as found
// when its `evidence` string appears verbatim in a tool response. Returned
// edges are scored against `true_edges` for precision and against a question's
// `expected_edges` for recall. If the golden drifts from its fixture, the bench
// scores the engine against code that isn't there, and the number looks just
// as authoritative. These tests pin every reference in the golden to the bytes
// on disk. They do not exercise the engine.
//
// Symbols are written '<fixture-relative path>::<name>' with no class
// qualifier, so a name must be defined exactly once in its file.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

interface Fact { id: string; file: string; line: number; evidence: string }
interface Target { file: string; line: number }
interface PlanStep { tool: string; args?: Record<string, unknown>; target?: Target }
interface Question {
  id: string;
  question: string;
  plan: PlanStep[];
  facts: Fact[];
  expected_edges?: Array<[string, string]>;
}
interface Golden {
  fixture: string;
  description: string;
  questions: Question[];
  true_edges: Array<[string, string, string]>;
}

const ROOT = resolve(import.meta.dirname, "..");
const GOLDEN_PATH = join(import.meta.dirname, "fixtures", "orders_app.golden.json");
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Golden;
const FIXTURE = resolve(ROOT, golden.fixture);

const EDGE_KINDS = new Set(["call", "http", "event"]);
const DEFINITION = /^\s*(?:export\s+)?(?:async\s+)?(?:def|class|function|func|type|interface)\s+\w+/;

const cache = new Map<string, string[]>();

/** Lines of a fixture file. Fails the calling test if the path escapes the fixture or is not a file. */
function linesOf(file: string): string[] {
  const cached = cache.get(file);
  if (cached) return cached;
  assert.ok(!isAbsolute(file) && !file.split(/[\\/]/).includes(".."), `${file} must be fixture-relative`);
  const path = join(FIXTURE, file);
  assert.ok(statSync(path, { throwIfNoEntry: false })?.isFile(), `${file} does not exist in ${golden.fixture}`);
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  cache.set(file, lines);
  return lines;
}

function parseSymbol(ref: string): { file: string; name: string } {
  const parts = ref.split("::");
  assert.equal(parts.length, 2, `${ref} is not '<path>::<name>'`);
  const [file, name] = parts as [string, string];
  assert.ok(file && /^\w+$/.test(name), `${ref} is not '<path>::<name>'`);
  return { file, name };
}

function definesName(name: string): RegExp {
  return new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?(?:def|class|function|func|type|interface)\\s+${name}\\b`);
}

/** 0-based index of the one line that defines `name` in `file`. */
function definitionOf(ref: string): { lines: string[]; index: number } {
  const { file, name } = parseSymbol(ref);
  const lines = linesOf(file);
  const pattern = definesName(name);
  const hits = lines.flatMap((line, index) => (pattern.test(line) ? [index] : []));
  assert.equal(hits.length, 1, `${ref}: expected one definition of ${name} in ${file}, found ${hits.length}`);
  return { lines, index: hits[0]! };
}

/** Lines indented under a definition. The fixture is formatted, so indentation delimits bodies in all its languages. */
function bodyOf(lines: string[], index: number): string[] {
  const indent = (line: string) => line.length - line.trimStart().length;
  const own = indent(lines[index]!);
  const body: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (line.trim() !== "" && indent(line) <= own) break;
    body.push(line);
  }
  return body;
}

const allFacts = golden.questions.flatMap((q) => q.facts);
const allRefs = [
  ...golden.true_edges.flatMap(([from, to]) => [from, to]),
  ...golden.questions.flatMap((q) => (q.expected_edges ?? []).flat()),
];

describe("orders_app golden: shape", () => {
  test("`fixture` names the fixture directory, relative to the repo root", () => {
    assert.ok(!isAbsolute(golden.fixture), "fixture must be repo-relative so the golden is portable");
    assert.ok(statSync(FIXTURE, { throwIfNoEntry: false })?.isDirectory(), `${golden.fixture} is not a directory`);
  });

  test("question ids and fact ids are unique", () => {
    const questionIds = golden.questions.map((q) => q.id);
    assert.equal(new Set(questionIds).size, questionIds.length, "duplicate question id");
    const factIds = allFacts.map((f) => f.id);
    assert.equal(new Set(factIds).size, factIds.length, "duplicate fact id");
  });

  test("every question has a plan, and something to score it against", () => {
    for (const q of golden.questions) {
      assert.ok(q.plan.length > 0, `${q.id} has an empty plan`);
      assert.ok(q.facts.length + (q.expected_edges?.length ?? 0) > 0, `${q.id} has neither facts nor expected edges`);
    }
  });

  test("every true edge has a known kind", () => {
    for (const [from, to, kind] of golden.true_edges) {
      assert.ok(EDGE_KINDS.has(kind), `${from} -> ${to} has unknown kind ${kind}`);
    }
  });

  test("every expected edge is also a true edge", () => {
    // Otherwise the bench would score a hit on an expected edge as a false edge.
    const truth = new Set(golden.true_edges.map(([from, to]) => `${from} -> ${to}`));
    for (const q of golden.questions) {
      for (const [from, to] of q.expected_edges ?? []) {
        assert.ok(truth.has(`${from} -> ${to}`), `${q.id}: ${from} -> ${to} is not in true_edges`);
      }
    }
  });
});

describe("orders_app golden: facts match the fixture line for line", () => {
  for (const fact of allFacts) {
    test(`${fact.id}: ${fact.file}:${fact.line} contains ${JSON.stringify(fact.evidence)}`, () => {
      const lines = linesOf(fact.file);
      assert.ok(Number.isInteger(fact.line) && fact.line >= 1 && fact.line <= lines.length,
        `line ${fact.line} is outside ${fact.file} (1..${lines.length})`);
      assert.ok(lines[fact.line - 1]!.includes(fact.evidence),
        `${fact.file}:${fact.line} is ${JSON.stringify(lines[fact.line - 1])}`);
    });
  }
});

describe("orders_app golden: symbols resolve to definitions in the fixture", () => {
  for (const ref of [...new Set(allRefs)].sort()) {
    test(`${ref} is defined exactly once`, () => {
      definitionOf(ref);
    });
  }

  test("every plan target is a definition line in an existing file", () => {
    for (const q of golden.questions) {
      for (const step of q.plan) {
        if (!step.target) continue;
        const { file, line } = step.target;
        const text = linesOf(file)[line - 1];
        assert.ok(text !== undefined && DEFINITION.test(text),
          `${q.id} ${step.tool}: ${file}:${line} is not a definition (${JSON.stringify(text)})`);
      }
    }
  });

  test("every call edge's callee is named inside the caller's body", () => {
    // http and event edges cross a URL or a topic, which a text check cannot
    // prove. Direct calls it can: the callee must be named in the caller.
    for (const [from, to, kind] of golden.true_edges) {
      if (kind !== "call") continue;
      const { lines, index } = definitionOf(from);
      const callee = new RegExp(`\\b${parseSymbol(to).name}\\b`);
      assert.ok(bodyOf(lines, index).some((line) => callee.test(line)),
        `${from} -> ${to}: ${parseSymbol(to).name} is not named in the body of ${parseSymbol(from).name}`);
    }
  });
});
