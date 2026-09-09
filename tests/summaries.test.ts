// Tests for the LLM boundary (task P3-T2, R34 / R62 / R63 / R64).
//
// The important test in this file is the containment one. R63 asks for the LLM
// boundary to be enforced STRUCTURALLY, and a structural property that nothing
// checks is a convention. The failure it prevents is invisible by design: a
// model writes a plausible relationship, a traversal treats it as fact, and
// later nobody can separate what was observed from what was imagined.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactStore } from "../src/store/db.ts";
import {
  functionInput, hashInput, NoProviderConfigured, readSummary, summarise,
  verifyContainment, writeSummary, type SummaryProvider,
} from "../src/llm/summaries.ts";

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), "code-intel-llm-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

/** A provider that records what it was asked, so caching is observable. */
function fakeProvider(text = "It does a thing."): SummaryProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "fake", model: "fake-1", calls,
    async complete(prompt: string) {
      calls.push(prompt);
      return { text, tokensIn: 100, tokensOut: 20 };
    },
  };
}

describe("R63 — structural containment", () => {
  test("summaries has NO foreign key, so no traversal can join it", () => {
    // This looks like a schema mistake and is the point: a real FK would make
    // `summaries` a joinable relation, and the next person writing a query
    // would join it.
    const store = new FactStore(join(dir, "fk.db"));
    try {
      const report = verifyContainment(store);
      assert.deepEqual(report.foreignKeys, []);
      assert.equal(report.ok, true);
    } finally { store.close(); }
  });

  test("no module in src/query reads the summaries table", () => {
    // Checked against the real sources, not a fixture. If someone adds a join
    // in six months, this fails in their PR rather than in production.
    const queryDir = join(import.meta.dirname, "..", "src", "query");
    const sources: Record<string, string> = {};
    for (const name of readdirSync(queryDir)) {
      if (name.endsWith(".ts")) {
        sources[name] = readFileSync(join(queryDir, name), "utf8");
      }
    }
    const store = new FactStore(join(dir, "queries.db"));
    try {
      const report = verifyContainment(store, sources);
      assert.deepEqual(
        report.referencingQueries, [],
        "a query joining summaries would let model output be read as fact",
      );
    } finally { store.close(); }
  });

  test("the containment check FAILS when a query does reference summaries", () => {
    // The guard has to be able to fail, or it proves nothing.
    const store = new FactStore(join(dir, "detect.db"));
    try {
      const report = verifyContainment(store, {
        "bad.ts": "SELECT * FROM edges JOIN summaries ON ...",
      });
      assert.equal(report.ok, false);
      assert.deepEqual(report.referencingQueries, ["bad.ts"]);
    } finally { store.close(); }
  });

  test("writeSummary is the only write path, and it reaches one table", () => {
    const store = new FactStore(join(dir, "onlypath.db"));
    try {
      const before = store.countRows("edges");
      writeSummary(store, {
        nodeKey: "scip npm svc 1 `s.js`/f().", kind: "function",
        inputSha256: hashInput("x"), summary: "does a thing",
        model: "m", provider: "p", tokensIn: 1, tokensOut: 1,
        generatedAt: new Date().toISOString(),
      });
      assert.equal(store.countRows("summaries"), 1);
      assert.equal(store.countRows("edges"), before, "no edge was written");
    } finally { store.close(); }
  });
});

describe("R64 — caching by input hash", () => {
  test("a second call with identical input costs no tokens", () => {
    const store = new FactStore(join(dir, "cache.db"));
    const provider = fakeProvider();
    return (async () => {
      try {
        const request = { nodeKey: "k", kind: "function" as const, input: "signature: f()" };
        const first = await summarise(store, request, provider);
        assert.equal(first.cached, false);
        assert.equal(provider.calls.length, 1);

        const second = await summarise(store, request, provider);
        assert.equal(second.cached, true);
        assert.equal(provider.calls.length, 1, "the model was not called again");
        assert.equal(second.summary, first.summary);
      } finally { store.close(); }
    })();
  });

  test("changed input regenerates; that is the whole invalidation rule", async () => {
    const store = new FactStore(join(dir, "invalidate.db"));
    const provider = fakeProvider();
    try {
      await summarise(store, { nodeKey: "k", kind: "function", input: "v1" }, provider);
      await summarise(store, { nodeKey: "k", kind: "function", input: "v2" }, provider);
      assert.equal(provider.calls.length, 2);
      assert.equal(store.countRows("summaries"), 2, "both versions are kept, keyed by hash");
    } finally { store.close(); }
  });

  test("a cached summary can be read without a provider at all", async () => {
    const store = new FactStore(join(dir, "readback.db"));
    try {
      await summarise(store, { nodeKey: "k", kind: "module", input: "x" }, fakeProvider("m"));
      const row = readSummary(store, "k", "module");
      assert.equal(row?.summary, "m");
      assert.equal(row?.provider, "fake");
    } finally { store.close(); }
  });

  test("token counts are stored, so R64's cost claim is measurable", async () => {
    const store = new FactStore(join(dir, "tokens.db"));
    try {
      const r = await summarise(store, { nodeKey: "k", kind: "function", input: "x" }, fakeProvider());
      assert.equal(r.tokensIn, 100);
      assert.equal(r.tokensOut, 20);
    } finally { store.close(); }
  });
});

describe("OPEN-8 — no provider configured", () => {
  test("a cache miss with no provider names what is missing", async () => {
    // Silently producing nothing would read as "this function has no summary".
    const store = new FactStore(join(dir, "noprovider.db"));
    try {
      await assert.rejects(
        () => summarise(store, { nodeKey: "k", kind: "function", input: "x" }),
        (e: unknown) => {
          assert.ok(e instanceof NoProviderConfigured);
          assert.match(e.message, /OPEN-8/);
          return true;
        },
      );
    } finally { store.close(); }
  });

  test("a cache HIT works with no provider, because nothing needs generating", async () => {
    const store = new FactStore(join(dir, "hitnoprovider.db"));
    try {
      const request = { nodeKey: "k", kind: "function" as const, input: "x" };
      await summarise(store, request, fakeProvider());
      const again = await summarise(store, request);
      assert.equal(again.cached, true);
    } finally { store.close(); }
  });
});

describe("prompt input is facts only", () => {
  test("a function's input carries signature, neighbours and exits", () => {
    const store = new FactStore(join(dir, "input.db"));
    try {
      const repoId = store.upsertRepo("svc", "/tmp/svc", "svc");
      const runId = store.startRun(repoId, "static", "t", "");
      const fileId = store.upsertFile(repoId, "s.js", "js", "h", runId);
      const key = "scip npm svc 1 `s.js`/handler().";
      const node = store.upsertNode("symbol", key, repoId);
      store.upsertSymbol({
        nodeId: node, fileId, displayName: "handler", symbolKind: "method",
        signature: "function handler(req, reply): void", startLine: 10, endLine: 40,
      });
      const callee = store.upsertNode("symbol", "scip npm svc 1 `s.js`/check().", repoId);
      store.insertEdge({
        srcNodeId: node, dstNodeId: callee, type: "CALLS", confidence: "certain",
        evidenceKind: "scip", fileId, line: 11, runId,
      });
      store.replaceCfg(node, [
        {
          symbolNodeId: node, blockIndex: 0, parentIndex: null, kind: "root",
          startLine: 10, endLine: 40, fileId, runId,
        },
        {
          symbolNodeId: node, blockIndex: 1, parentIndex: 0, kind: "guard",
          conditionText: "!token", startLine: 12, endLine: 12, fileId, runId,
        },
        {
          symbolNodeId: node, blockIndex: 2, parentIndex: 1, kind: "exit",
          outcome: "error_exit", exitForm: "return_error", errorName: "HTTP 401",
          startLine: 12, endLine: 12, fileId, runId,
        },
      ]);

      const input = functionInput(store, key)!;
      assert.match(input, /signature: function handler/);
      assert.match(input, /check\(\)/);
      assert.match(input, /error_exit via return_error \(HTTP 401\) when !token/);
      // No other summary is fed in: building a summary from summaries makes
      // cache invalidation transitive and a stale leaf poisons everything above.
      assert.ok(!input.includes("summary"), "facts only");
    } finally { store.close(); }
  });

  test("an unknown symbol yields null rather than an empty prompt", () => {
    const store = new FactStore(join(dir, "missing.db"));
    try {
      assert.equal(functionInput(store, "not-a-symbol"), null);
    } finally { store.close(); }
  });
});
