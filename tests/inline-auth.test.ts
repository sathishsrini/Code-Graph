// Tests for the inline security-check detector (task P1-T10, R26).
//
// The idioms are tested against the shapes the corpus actually uses:
//   `const authErr = checkUserAuth(req, reply); if (authErr) return authErr;`
//   `auth = request.headers.get("authorization", "")` then an early 401 return.
//
// A negative corpus example sits beside every positive one: this detector's
// whole value is that it fires on the reviewed-helper sentinel-return and the
// header-compared early 401, and on nothing else.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFile } from "../src/static/treesitter/parser.ts";
import { extract, type FileFindings } from "../src/static/treesitter/extract.ts";
import {
  detectInBody, ingestInlineChecks, resolveHandlerFunction, PY_DETAIL,
} from "../src/static/inline-auth.ts";
import { loadCheckKindRules } from "../src/static/security-rules.ts";
import type { BootRoute } from "../src/boot/dump.ts";
import { FactStore } from "../src/store/db.ts";
import { GraphWriter } from "../src/normalize/graph.ts";

const rules = loadCheckKindRules("rules/check-kinds.yml");

async function scan(source: string, routeLine: number): Promise<ReturnType<typeof detectInBody>> {
  const parsed = await parseFile("snippet.js", source);
  assert.ok(parsed, "snippet should parse");
  const findings: FileFindings = extract(parsed);
  const fn = resolveHandlerFunction(findings.functions, routeLine);
  assert.ok(fn, `handler line ${routeLine} should resolve to a function`);
  return detectInBody(parsed, fn, rules);
}

describe("JS sentinel-return idiom", () => {
  const IDIOM = [
    "async function handler(req, reply) {",
    "  const authErr = checkUserAuth(req, reply);",
    "  if (authErr) return authErr;",
    "  return reply.send({ ok: true });",
    "}",
  ].join("\n");

  test("binds a reviewed helper call guarded by the sentinel return", async () => {
    const checks = await scan(IDIOM, 1);
    assert.equal(checks.length, 1);
    assert.equal(checks[0]!.name, "checkUserAuth");
    assert.equal(checks[0]!.checkKind, "auth");
    assert.equal(checks[0]!.detail, "reviewed helper checkUserAuth");
    assert.equal(checks[0]!.line, 2);
  });

  test("accepts the single-line corpus form", async () => {
    const engine = [
      "app.post('/api/v1/po', async (req, reply) => {",
      "  const authErr = serviceAuth(req, reply); if (authErr) return authErr;",
      "  await db.save(req.body);",
      "  return reply.send({});",
      "});",
    ].join("\n");
    const checks = await scan(engine, 1);
    assert.equal(checks.length, 1);
    assert.equal(checks[0]!.name, "serviceAuth");
    assert.equal(checks[0]!.checkKind, "auth");
    assert.equal(checks[0]!.detail, "reviewed helper serviceAuth");
    assert.equal(checks[0]!.line, 2);
  });

  test("a direct `return helper(...)` is a check without a guard", async () => {
    const direct = [
      "async function handler(req, reply) {",
      "  return requireAuth(req, reply);",
      "}",
    ].join("\n");
    const checks = await scan(direct, 1);
    assert.equal(checks.length, 1);
    assert.equal(checks[0]!.name, "requireAuth");
    // A discarded result does not stop the request — the detail says so, so
    // P1-T14's matrix does not read it as a sentinel-return (fix 3).
    assert.equal(checks[0]!.detail, "reviewed helper requireAuth, unguarded call");
  });

  test("a helper call without the sentinel guard is not a check", async () => {
    const unguarded = [
      "async function handler(req, reply) {",
      "  const authErr = checkUserAuth(req, reply);",
      "  if (authErr) console.error('denied');",
      "  return reply.send({ ok: true });",
      "}",
    ].join("\n");
    assert.deepEqual(await scan(unguarded, 1), []);
  });

  test("a guard on a value that is not a reviewed-helper call is not a check", async () => {
    const dbGuard = [
      "async function handler(req, reply) {",
      "  const authErr = req.headers.authorization;",
      "  if (authErr) return authErr;",
      "  return reply.send({ ok: true });",
      "}",
    ].join("\n");
    assert.deepEqual(await scan(dbGuard, 1), []);
  });

  test("an unreviewed helper is never bound, even with the guard shape", async () => {
    const unreviewed = [
      "async function handler(req, reply) {",
      "  const authErr = myPrivateCheck(req);",
      "  if (authErr) return authErr;",
      "  return reply.send({ ok: true });",
      "}",
    ].join("\n");
    assert.deepEqual(await scan(unreviewed, 1), []);
  });

  test("a check inside a nested closure is pruned", async () => {
    const nested = [
      "async function handler(req, reply) {",
      "  const doWork = () => {",
      "    const authErr = checkUserAuth(req, reply);",
      "    if (authErr) return authErr;",
      "  };",
      "  doWork();",
      "  return reply.send({ ok: true });",
      "}",
    ].join("\n");
    assert.deepEqual(await scan(nested, 1), []);
  });

  test("returns two rows, ordered by position, when there are two checks", async () => {
    const two = [
      "async function handler(req, reply) {",
      "  const tenantErr = requireTenant(req, reply);",
      "  if (tenantErr) return tenantErr;",
      "  const authErr = checkUserAuth(req, reply);",
      "  if (authErr) return authErr;",
      "  return reply.send({ ok: true });",
      "}",
    ].join("\n");
    const checks = await scan(two, 1);
    assert.deepEqual(
      checks.map((c) => `${c.name}/${c.checkKind}/${c.detail}/${c.line}`),
      [
        "requireTenant/tenant/reviewed helper requireTenant/2",
        "checkUserAuth/auth/reviewed helper checkUserAuth/4",
      ],
    );
  });
});

describe("Python header-compare-and-early-401 idiom", () => {
  const FN = "async def send_mail(request):"; // decorator line sits above, as FastAPI reports it.
  const PARTS = [
    FN,
    '    cid = request.state.correlation_id',
    '    auth = request.headers.get("authorization", "")',
    '    token = auth.replace("Bearer ", "").strip()',
    '    ikey = request.headers.get("x-integration-key", "")',
    '    if token != SERVICE_TOKEN:',
    '        return JSONResponse(status_code=401, content={})',
    '    if ikey != INTEGRATION_KEY:',
    '        return JSONResponse(status_code=401, content={})',
    "    return {'sent': True}",
  ].join("\n");

  async function scanPy(source: string, handlerLine: number) {
    const parsed = await parseFile("snippet.py", source);
    assert.ok(parsed, "snippet should parse");
    const findings = extract(parsed);
    const fn = resolveHandlerFunction(findings.functions, handlerLine);
    assert.ok(fn, `handler line ${handlerLine} should resolve`);
    return detectInBody(parsed, fn, rules);
  }

  test("matches the handler at its decorator line (FastAPI reports 1 above def)", async () => {
    const checks = await scanPy(PARTS, 1); // the @app.post line, not `async def`
    assert.equal(checks.length, 2);
    for (const c of checks) {
      assert.equal(c.name, null);
      assert.equal(c.checkKind, "auth");
      assert.equal(c.detail, PY_DETAIL);
    }
    assert.deepEqual(checks.map((c) => c.line), [7, 9]);
  });

  test("matches at the def line too (a non-decorated handler)", async () => {
    const checks = await scanPy(PARTS, 2);
    assert.equal(checks.length, 2);
  });

  test("a 401 return with no header-derived guard is not an inline check", async () => {
    const unguarded = [
      FN,
      "    if request.method == 'POST':",
      "        return JSONResponse(status_code=401, content={})",
      "    return {'ok': True}",
    ].join("\n");
    assert.deepEqual(await scanPy(unguarded, 2), []);
  });

  test("a header read that never guards a 401 return is not an inline check", async () => {
    const noReturn = [
      FN,
      '    auth = request.headers.get("authorization", "")',
      "    print(auth)",
      "    return {'ok': True}",
    ].join("\n");
    assert.deepEqual(await scanPy(noReturn, 2), []);
  });

  test("a non-401 early return is not an inline check", async () => {
    const not401 = [
      FN,
      '    auth = request.headers.get("authorization", "")',
      "    if not auth:",
      "        return JSONResponse(status_code=403, content={})",
      "    return {'ok': True}",
    ].join("\n");
    assert.deepEqual(await scanPy(not401, 2), []);
  });

  test("a 401 derived from a compared header value counts (no binding indirection)", async () => {
    const direct = [
      FN,
      '    if request.headers.get("authorization", "") != SECRET:',
      "        return JSONResponse(status_code=401, content={})",
      "    return {'ok': True}",
    ].join("\n");
    const checks = await scanPy(direct, 2);
    assert.equal(checks.length, 1);
  });
});

describe("ingestInlineChecks — rows, provenance, and the no-semgrep guard", () => {
  const dir = mkdtempSync(join(tmpdir(), "code-intel-inline-"));

  function seedStore(store: FactStore): { repoId: number; runId: number; routeNodeId: number } {
    const repoId = store.upsertRepo("svc", "/tmp/svc", "svc");
    const runId = store.startRun(repoId, "static", "code-intel/P1", "");
    const routeNodeId = store.upsertNode("route", "svc GET /api/v1/po", repoId);
    store.upsertRoute({
      nodeId: routeNodeId, repoId, serviceName: "svc", method: "GET", url: "/api/v1/po",
      source: "boot", runId,
    });
    return { repoId, runId, routeNodeId };
  }

  function bootRoute(): BootRoute {
    return {
      method: "GET", url: "/api/v1/po", prefix: "", routeKey: "svc GET /api/v1/po",
      constraints: null, hasSchema: false, logLevel: null, offPath: [],
      chain: [{
        position: 0, phase: "handler", name: null, key: "snippet.js:1:15", file: "snippet.js",
        line: 1, col: 15, anonymous: true, origin: "route", declaredIn: null, inheritedFrom: null,
      }],
    };
  }

  test("writes handler_inline rows with treesitter provenance and the detail discriminator", async () => {
    const store = new FactStore(join(dir, "rows.db"));
    try {
      const { repoId, runId, routeNodeId } = seedStore(store);
      store.upsertFile(repoId, "snippet.js", "js", "h1", runId);
      const writer = new GraphWriter(store, runId, repoId, { localPackages: new Set(["svc"]) });

      const parsed = await parseFile("snippet.js", [
        "async function handler(req, reply) {",
        "  const authErr = checkUserAuth(req, reply);",
        "  if (authErr) return authErr;",
        "  return reply.send({ ok: true });",
        "}",
      ].join("\n"));
      assert.ok(parsed);
      const findings = extract(parsed);

      const n = ingestInlineChecks([bootRoute()], {
        store, writer, service: "svc", repoId, runId, rules,
        parsedByPath: new Map([["snippet.js", parsed]]),
        findingsByPath: new Map([["snippet.js", findings]]),
        fileIds: new Map([["snippet.js", store.getFile(repoId, "snippet.js")!.id]]),
      });
      assert.equal(n, 1);

      const row = store.raw().prepare(
        "SELECT rc.phase, rc.confidence, rc.evidence_kind, rc.check_kind, rc.detail, rc.line, rc.origin " +
        "FROM route_chain rc WHERE rc.route_node_id = ?",
      ).get(routeNodeId) as Record<string, unknown>;
      assert.equal(row["phase"], "handler_inline");
      assert.equal(row["confidence"], "inferred");
      assert.equal(row["evidence_kind"], "treesitter");
      assert.equal(row["check_kind"], "auth");
      assert.equal(row["detail"], "reviewed helper checkUserAuth");
      assert.equal(row["line"], 2);
      assert.equal(row["origin"], "handler");
    } finally { store.close(); }
  });

  test("un-reviewing a helper empties its rows (delete-before-insert, fix 1)", async () => {
    const store = new FactStore(join(dir, "unreview.db"));
    try {
      const { repoId, runId, routeNodeId } = seedStore(store);
      store.upsertFile(repoId, "snippet.js", "js", "h1", runId);
      const writer = new GraphWriter(store, runId, repoId, { localPackages: new Set(["svc"]) });
      const parsed = await parseFile("snippet.js", [
        "async function handler(req, reply) {",
        "  const authErr = checkUserAuth(req, reply);",
        "  if (authErr) return authErr;",
        "  return reply.send({ ok: true });",
        "}",
      ].join("\n"));
      assert.ok(parsed);
      const findings = extract(parsed);
      const opts = () => ({
        store, writer, service: "svc", repoId, runId, rules,
        parsedByPath: new Map([["snippet.js", parsed]]),
        findingsByPath: new Map([["snippet.js", findings]]),
        fileIds: new Map([["snippet.js", store.getFile(repoId, "snippet.js")!.id]]),
      });
      const count = () => store.raw().prepare(
        "SELECT COUNT(*) AS n FROM route_chain WHERE route_node_id = ?",
      ).get(routeNodeId) as { n: number };

      // Reviewed: one row.
      assert.equal(ingestInlineChecks([bootRoute()], opts()), 1);
      assert.equal(count().n, 1);

      // Un-review `checkUserAuth`: the same handler now yields no checks, and
      // the previous run's rows must not survive (the D5 direction — a revoked
      // rule cannot keep asserting coverage).
      const without = { byName: new Map([...rules.byName].filter(([h]) => h !== "checkUserAuth")) };
      assert.equal(ingestInlineChecks([bootRoute()], { ...opts(), rules: without }), 0);
      assert.equal(count().n, 0);
    } finally { store.close(); }
  });

  test("no producer writes evidence_kind 'semgrep' anywhere in src", () => {
    // The settled plan rule: `'semgrep'` stays in the CHECK constraint but no
    // current writer emits it — introducing a semgrep producer is a deliberate,
    // reviewable flip. This test turns that into a structural assertion.
    const srcRoot = join("src");
    const offenders: string[] = [];
    for (const file of walkTs(srcRoot)) {
      const text = readFileSync(file, "utf8");
      for (const line of text.split(/\r?\n/)) {
        if (/evidence[_]?kind\s*:\s*["']semgrep["']/.test(line)) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  after(() => rmSync(dir, { recursive: true, force: true }));
});

function walkTs(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walkTs(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}