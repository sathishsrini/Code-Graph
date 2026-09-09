// Tests for the P3-T2 orchestration: plan order, generation, and the
// module/service/path input builders that turn store facts into prompts.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactStore } from "../src/store/db.ts";
import {
  moduleInput, serviceInput, endpointPathInput, planGeneration, generateFromPlan, PlanError,
} from "../src/llm/orchestrate.ts";
import type { SummaryProvider } from "../src/llm/summaries.ts";

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), "code-intel-orchestrate-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

const SYM = (name: string) => `scip npm svc 1 \`server.js\`/${name}().`;

function fakeProvider(): SummaryProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "fake", model: "fake-1", calls,
    async complete(prompt: string) {
      calls.push(prompt);
      return { text: "It does a thing.", tokensIn: 10, tokensOut: 5 };
    },
  };
}

/** Two services; a has a file with a handler+helper, a route and a gap. */
function scaffold(store: FactStore): { aRepoId: number; bRepoId: number; runIdA: number } {
  const aRepoId = store.upsertRepo("a", "/tmp/a", "a");
  const bRepoId = store.upsertRepo("b", "/tmp/b", "b");
  const runIdA = store.startRun(aRepoId, "static", "test@0", "");
  store.startRun(bRepoId, "static", "test@0", "");

  const fileId = store.upsertFile(aRepoId, "server.js", "js", "h", runIdA);
  store.upsertFile(bRepoId, "app.js", "js", "h", runIdA);
  store.upsertNode("file", "a/server.js", aRepoId);
  store.upsertNode("file", "b/app.js", bRepoId);

  const aHandler = store.upsertNode("symbol", SYM("handler"), aRepoId);
  const aHelper = store.upsertNode("symbol", SYM("helper"), aRepoId);
  const bRoute = store.upsertNode("route", "b GET /q", bRepoId);

  store.upsertSymbol({
    nodeId: aHandler, fileId, displayName: "handler", symbolKind: "method",
    signature: "function handler(req, reply): void", startLine: 10, endLine: 40,
  });
  store.upsertSymbol({
    nodeId: aHelper, fileId, displayName: "helper", symbolKind: "method",
    signature: "function helper(): string", startLine: 2, endLine: 8,
  });

  // a's route, handled in server.js
  const route = store.upsertNode("route", "a POST /p", aRepoId);
  store.upsertRoute({
    nodeId: route, repoId: aRepoId, serviceName: "a", method: "POST", url: "/p",
    source: "boot", runId: runIdA, handlerNodeId: aHandler,
  });
  store.insertChainEntry({
    routeNodeId: route, position: 0, phase: "handler", origin: "route",
    symbolNodeId: aHandler, confidence: "certain", evidenceKind: "boot",
    fileId, line: 1, runId: runIdA,
  });

  // b's route exists so the REQUESTS edge to it expands instead of throwing
  const bFileId = store.upsertFile(bRepoId, "app.js", "js", "h", runIdA);
  const bHandler = store.upsertNode("symbol", `scip npm b 1 \`app.js\`/run().`, bRepoId);
  store.upsertSymbol({
    nodeId: bHandler, fileId: bFileId, displayName: "run", symbolKind: "method",
    signature: "function run(): void", startLine: 1, endLine: 2,
  });
  store.upsertRoute({
    nodeId: bRoute, repoId: bRepoId, serviceName: "b", method: "GET", url: "/q",
    source: "boot", runId: runIdA, handlerNodeId: bHandler,
  });
  store.insertChainEntry({
    routeNodeId: bRoute, position: 0, phase: "handler", origin: "route",
    symbolNodeId: bHandler, confidence: "certain", evidenceKind: "boot",
    fileId: bFileId, line: 1, runId: runIdA,
  });

  // handler calls helper, and asks service b
  store.insertEdge({
    srcNodeId: aHandler, dstNodeId: aHelper, type: "CALLS", confidence: "certain",
    evidenceKind: "scip", fileId, line: 11, runId: runIdA,
  });
  store.insertEdge({
    srcNodeId: aHandler, dstNodeId: bRoute, type: "REQUESTS", confidence: "certain",
    evidenceKind: "boot", fileId, line: 12, runId: runIdA,
  });

  // one gap: a call site that could not be resolved
  store.insertUnresolved({
    srcNodeId: aHandler, kind: "call",
    targetHint: "scip-typescript npm axios 1.7.2 index.d.ts/",
    reason: "callee resolved to a package, not to a function", runId: runIdA,
  });

  return { aRepoId, bRepoId, runIdA };
}

describe("planGeneration — bottom-up order (R66)", () => {
  test("module scope plans all functions first, the module last", () => {
    const store = new FactStore(join(dir, "modplan.db"));
    try {
      scaffold(store);
      const plan = planGeneration(store, "module", "a/server.js");
      assert.deepEqual(plan.map((p) => p.kind), ["function", "function", "module"]);
      assert.equal(plan.at(-1)?.kind, "module");
      assert.equal(plan.at(-1)?.nodeKey, "a/server.js");
    } finally { store.close(); }
  });

  test("service scope plans every file bottom-up, then the service last", () => {
    const store = new FactStore(join(dir, "servplan.db"));
    try {
      scaffold(store);
      const plan = planGeneration(store, "service", "a");
      const kinds = plan.map((p) => p.kind);
      assert.deepEqual(kinds.slice(0, 2), ["function", "function"]);
      assert.deepEqual(kinds.slice(2), ["module", "service"]);
      assert.equal(plan.at(-1)?.nodeKey, "a", "service key is the value in serviceInput");
    } finally { store.close(); }
  });

  test("unknown seeds raise a PlanError naming the scope", () => {
    const store = new FactStore(join(dir, "badseed.db"));
    try {
      assert.throws(() => planGeneration(store, "function", "nope"),
        (e: unknown) => e instanceof PlanError && /symbol/.test((e as Error).message));
      assert.throws(() => planGeneration(store, "service", "nope"),
        (e: unknown) => e instanceof PlanError && /repo/.test((e as Error).message));
    } finally { store.close(); }
  });
});

describe("generateFromPlan — cache-first, bottom-up", () => {
  test("first run generates with a provider; re-run is pure cache", async () => {
    const store = new FactStore(join(dir, "gen.db"));
    const provider = fakeProvider();
    try {
      scaffold(store);
      const plan = planGeneration(store, "module", "a/server.js");
      const first = await generateFromPlan(store, plan, provider);
      assert.equal(first.generated.length, plan.length);
      assert.equal(first.hitCache, 0);
      assert.equal(provider.calls.length, plan.length);

      const second = await generateFromPlan(store, plan, provider);
      assert.equal(second.generated.length, 0);
      assert.equal(second.hitCache, plan.length);
      assert.equal(provider.calls.length, plan.length, "no model call on a full cache hit");
    } finally { store.close(); }
  });

  test("with no provider, misses are reported as skips, not silent zeros", async () => {
    const store = new FactStore(join(dir, "noprov.db"));
    try {
      scaffold(store);
      const plan = planGeneration(store, "module", "a/server.js");
      const report = await generateFromPlan(store, plan, null);
      assert.equal(report.generated.length, 0);
      assert.equal(report.skipped.length, plan.length);
      assert.equal(report.needsProvider, true);
      assert.ok(report.skipped.some((s) => s.nodeKey.includes("handler")));
    } finally { store.close(); }
  });
});

describe("input builders are facts only", () => {
  test("moduleInput carries a file's functions, their calls and its routes", () => {
    const store = new FactStore(join(dir, "modin.db"));
    try {
      scaffold(store);
      const input = moduleInput(store, "a/server.js")!;
      assert.match(input, /^file: a\/server\.js/);
      assert.match(input, /function handler\(req, reply\)/);
      assert.match(input, /function helper\(\)/);
      assert.match(input, /calls: helper/);
      assert.match(input, /handles:\n  POST \/p/);
      assert.ok(!input.includes("summary"), "facts only, never another summary");
    } finally { store.close(); }
  });

  test("serviceInput carries route surface, function count and gaps", () => {
    const store = new FactStore(join(dir, "servin.db"));
    try {
      scaffold(store);
      const input = serviceInput(store, "a")!;
      assert.match(input, /^service: a/);
      assert.match(input, /functions: 2/);
      assert.match(input, /POST \/p/);
      assert.match(input, /unresolved calls: 1/);
      assert.match(input, /b/);           // outbound dependency surface
    } finally { store.close(); }
  });

  test("endpointPathInput narrates the deterministic flow", () => {
    const store = new FactStore(join(dir, "pathin.db"));
    try {
      scaffold(store);
      const input = endpointPathInput(store, "a", "POST", "/p")!;
      assert.match(input, /^path: a POST \/p/);
      assert.match(input, /handler/);
    } finally { store.close(); }
  });
});