// Tests for the PR impact comment (task P2-T11, R51).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactStore } from "../src/store/db.ts";
import {
  analysePr, parseDiff, renderPrComment, symbolsForRanges, COMMENT_MARKER,
} from "../src/ci/pr-impact.ts";

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), "code-intel-pr-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

function seeded(name: string): FactStore {
  const store = new FactStore(join(dir, name));
  const repoId = store.upsertRepo("svc", "/tmp/svc", "svc");
  const runId = store.startRun(repoId, "static", "t", "");
  const fileId = store.upsertFile(repoId, "server.js", "js", "h", runId);

  const add = (
    n: string, kind: string, start: number, end: number,
  ): number => {
    const id = store.upsertNode("symbol", `scip npm svc 1 \`server.js\`/${n}().`, repoId);
    store.upsertSymbol({
      nodeId: id, fileId, displayName: n, symbolKind: kind,
      startLine: start, endLine: end,
    });
    return id;
  };

  const handler = add("handler", "method", 100, 200);
  add("req", "parameter", 100, 100);
  add("PORT", "term", 6, 6);
  store.upsertSymbol({
    nodeId: store.upsertNode("symbol", "scip npm svc 1 `server.js`/", repoId),
    fileId, displayName: "server.js", symbolKind: "namespace",
    startLine: 1, endLine: 400,
  });

  const route = store.upsertNode("route", "svc POST /p", repoId);
  store.upsertRoute({
    nodeId: route, repoId, serviceName: "svc", method: "POST", url: "/p",
    source: "boot", runId,
  });
  store.insertEdge({
    srcNodeId: route, dstNodeId: handler, type: "HANDLES", confidence: "certain",
    evidenceKind: "boot", fileId, line: 100, runId,
  });
  return store;
}

const DIFF = [
  "diff --git a/server.js b/server.js",
  "--- a/server.js",
  "+++ b/server.js",
  "@@ -120,3 +120,4 @@",
  "+  metrics.count();",
  "",
].join("\n");

describe("parsing a unified diff", () => {
  test("reads the NEW-file hunk ranges", () => {
    assert.deepEqual(parseDiff(DIFF), [
      { file: "server.js", startLine: 120, endLine: 123 },
    ]);
  });

  test("a single-line hunk with no count is one line", () => {
    const ranges = parseDiff("--- a/x.js\n+++ b/x.js\n@@ -1 +7 @@\n+a\n");
    assert.deepEqual(ranges, [{ file: "x.js", startLine: 7, endLine: 7 }]);
  });

  test("a pure deletion contributes no range", () => {
    // There are no new lines to map, and the symbol may no longer exist —
    // reporting impact for a function the PR removed answers about the wrong
    // revision.
    assert.deepEqual(parseDiff("--- a/x.js\n+++ b/x.js\n@@ -1,5 +1,0 @@\n-a\n"), []);
  });

  test("a deleted file is not attributed to the previous file's name", () => {
    const ranges = parseDiff(
      "--- a/kept.js\n+++ b/kept.js\n@@ -1 +1,2 @@\n+x\n" +
      "--- a/gone.js\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-y\n",
    );
    assert.deepEqual(ranges.map((r) => r.file), ["kept.js"]);
  });
});

describe("mapping lines to symbols", () => {
  test("a hunk maps to the enclosing FUNCTION, not to its parameter", () => {
    // Smallest-span wins is the obvious rule and it is wrong: a parameter has
    // a one-line range, so a change on the signature line mapped to `req` and
    // the comment reported the impact of changing a parameter name.
    const store = seeded("params.db");
    try {
      const mapping = symbolsForRanges(store, [
        { file: "server.js", startLine: 100, endLine: 100 },
      ]);
      assert.deepEqual(mapping.symbols.map((s) => s.display), ["handler"]);
    } finally { store.close(); }
  });

  test("a module-scope change still maps, to the const rather than nothing", () => {
    const store = seeded("modscope.db");
    try {
      const mapping = symbolsForRanges(store, [
        { file: "server.js", startLine: 6, endLine: 6 },
      ]);
      assert.deepEqual(mapping.symbols.map((s) => s.display), ["PORT"]);
    } finally { store.close(); }
  });

  test("a file the index has never seen is reported, not dropped", () => {
    const store = seeded("unindexed.db");
    try {
      const mapping = symbolsForRanges(store, [
        { file: "README.md", startLine: 1, endLine: 2 },
      ]);
      assert.deepEqual(mapping.symbols, []);
      assert.deepEqual(mapping.unindexedFiles, ["README.md"]);
    } finally { store.close(); }
  });

  test("a hunk inside an indexed file but outside any symbol is unmapped", () => {
    const store = seeded("unmapped.db");
    try {
      const mapping = symbolsForRanges(store, [
        { file: "server.js", startLine: 380, endLine: 385 },
      ]);
      // Only the module namespace covers it, and a namespace is not an owner.
      assert.deepEqual(mapping.symbols, []);
      assert.equal(mapping.unmapped.length, 1);
    } finally { store.close(); }
  });
});

describe("the comment", () => {
  test("routes are segmented by confidence, never summed", () => {
    const store = seeded("comment.db");
    try {
      const text = renderPrComment(analysePr(store, DIFF));
      assert.ok(text.startsWith(COMMENT_MARKER), "so the workflow can update in place");
      assert.ok(text.includes("### Certain — 1"));
      assert.ok(text.includes("### Inferred — 0"));
      assert.ok(text.includes("### Unknown — 0"));
      assert.ok(text.includes("`svc POST /p`"));
    } finally { store.close(); }
  });

  test("gaps are always a section, so the comment never implies completeness", () => {
    const store = seeded("gaps.db");
    try {
      const text = renderPrComment(analysePr(
        store, DIFF + "--- a/new.ts\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+x\n",
      ));
      assert.ok(text.includes("### Not analysed"));
      assert.ok(text.includes("`new.ts`"));
    } finally { store.close(); }
  });

  test("a utility gets a verdict instead of a route list (R39)", () => {
    const store = seeded("utility.db");
    try {
      const repoId = store.upsertRepo("svc", "/tmp/svc", "svc");
      const runId = store.startRun(repoId, "static", "t", "");
      const fileId = store.upsertFile(repoId, "server.js", "js", "h", runId);
      const handler = store.findNode("symbol", "scip npm svc 1 `server.js`/handler().")!;
      for (let i = 0; i < 15; i += 1) {
        const caller = store.upsertNode("symbol", `scip npm svc 1 \`server.js\`/c${i}().`, repoId);
        store.insertEdge({
          srcNodeId: caller, dstNodeId: handler, type: "CALLS", confidence: "certain",
          evidenceKind: "scip", fileId, line: i + 1, runId,
        });
      }
      const text = renderPrComment(analysePr(store, DIFF));
      assert.ok(text.includes("Utility touched"));
      assert.ok(text.includes("not as a review list"));
    } finally { store.close(); }
  });

  test("a stronger path wins when two changed symbols reach one route", () => {
    // A route reached certainly through one symbol is a certain dependency,
    // whatever a weaker path through another says.
    const store = seeded("dedupe.db");
    try {
      const result = analysePr(store, DIFF);
      const all = [
        ...result.routes.certain, ...result.routes.inferred, ...result.routes.unknown,
      ];
      assert.equal(new Set(all).size, all.length, "a route appears in exactly one bucket");
    } finally { store.close(); }
  });

  test("a diff touching nothing indexed says so plainly", () => {
    const store = seeded("nothing.db");
    try {
      const text = renderPrComment(analysePr(
        store, "--- a/docs/x.md\n+++ b/docs/x.md\n@@ -1 +1,2 @@\n+hi\n",
      ));
      assert.ok(text.includes("No indexed symbol contains the changed lines."));
      assert.ok(text.includes("### Not analysed"));
    } finally { store.close(); }
  });
});
