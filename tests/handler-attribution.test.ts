// Route-accurate attribution inside anonymous handlers (slice CTX-S10a).
//
// The gap, found by the first A/B answers (M11 #1): `context_pack
// checkUserAuth` did not list `POST /api/v1/mail/send` as a caller, although
// its anonymous handler calls it at `40-kri-router/server.js:292`. An arrow
// passed straight to `app.post` gets no SCIP definition of its own, so the
// call attributes to the MODULE and the SQL literal beside it to the FILE --
// the width M7 recorded for anonymous hooks, on the handler this time.
//
// The fix credits a module- or file-scope site to the route whose boot-located
// handler range (`route_chain.line` .. `end_line`) holds it. These tests run
// the real path end to end, as python-method-calls.test.ts does: source, SCIP
// bytes and a boot dump on disk -> indexRepo -> the store -> the queries.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FactStore } from "../src/store/db.ts";
import { indexRepo, type IndexReport } from "../src/index/pipeline.ts";
import { renderIndexReport } from "../src/index/report.ts";
import { contextPack, type PackedItem } from "../src/query/context-pack.ts";
import { impact } from "../src/query/impact.ts";
import type { RepoConfig } from "../src/config/repos.ts";
import type { ScipRange } from "../src/static/scip/reader.ts";
import { ROLE_DEFINITION } from "../src/static/scip/reader.ts";

// ---------------------------------------------------------------------------
// Fixture: the corpus idiom. CommonJS, built at module scope, inline handlers.
// 0-based indexes in the comments; the store and the assertions are 1-based.
// ---------------------------------------------------------------------------

const V1 = [
  "'use strict';",                                                       // 0
  "const Fastify = require('fastify');",                                 // 1
  "",                                                                    // 2
  "const app = Fastify();",                                              // 3
  "",                                                                    // 4
  "function checkUserAuth(req, reply) {",                                // 5
  "  return Boolean(req.headers.authorization);",                        // 6
  "}",                                                                   // 7
  "",                                                                    // 8
  "function makePool() {",                                               // 9
  "  return { query: async () => ({ rows: [] }) };",                     // 10
  "}",                                                                   // 11
  "",                                                                    // 12
  "const pool = makePool();",                                            // 13  module scope: stays file-scope
  "pool.query('SELECT id FROM settings');",                              // 14  module-scope SQL: stays file-scope
  "",                                                                    // 15
  "app.addHook('onRequest', async (req, reply) => {",                    // 16  every route runs this hook
  "  req.startTime = Date.now();",                                       // 17
  "});",                                                                 // 18
  "",                                                                    // 19
  "app.get('/health', async (req, reply) => {",                          // 20
  "  return { status: 'ok' };",                                          // 21
  "});",                                                                 // 22
  "",                                                                    // 23
  "app.post('/api/v1/mail/send', async (req, reply) => {",               // 24  opening line: `post` is the registering call
  "  if (!checkUserAuth(req, reply)) return;",                           // 25  -> server.js:26
  "  await pool.query('INSERT INTO mail_events (id) VALUES ($1)', [1]);", // 26  -> server.js:27
  "  return { ok: true };",                                              // 27
  "});",                                                                 // 28
  "",                                                                    // 29
  "app.listen({ port: 0 });",                                            // 30
];

/** V1 with the auth call moved from the POST handler into GET /health. */
const V2 = [
  ...V1.slice(0, 20),
  "app.get('/health', async (req, reply) => {",                          // 20
  "  if (!checkUserAuth(req, reply)) return;",                           // 21  -> server.js:22
  "  return { status: 'ok' };",                                          // 22
  "});",                                                                 // 23
  "",                                                                    // 24
  "app.post('/api/v1/mail/send', async (req, reply) => {",               // 25
  "  await pool.query('INSERT INTO mail_events (id) VALUES ($1)', [1]);", // 26
  "  return { ok: true };",                                              // 27
  "});",                                                                 // 28
  "",                                                                    // 29
  "app.listen({ port: 0 });",                                            // 30
];

const REPO = "kri-router";
const FILE = "server.js";
const PKG = `scip-typescript npm ${REPO} 1.0.0 `;
const MODULE = PKG + "`server.js`/";
const FASTIFY = "scip-typescript npm fastify 4.28.1 `fastify.d.ts`/FastifyInstance#";

// ---------------------------------------------------------------------------
// The scip-typescript transcript and the boot dump, both derived from the
// source lines so a moved line cannot leave a stale offset behind.
// ---------------------------------------------------------------------------

interface Occ { symbol: string; roles: number; range: ScipRange; enclosing?: ScipRange }

function occurrences(lines: string[]): Occ[] {
  const at = (line: number, start: number, text: string): ScipRange =>
    ({ startLine: line, startChar: start, endLine: line, endChar: start + text.length });
  const last = lines.length - 1;
  // scip-typescript's module definition: an empty name, the file as its body.
  const out: Occ[] = [{
    symbol: MODULE, roles: ROLE_DEFINITION, range: at(0, 0, ""),
    enclosing: { startLine: 0, startChar: 0, endLine: last, endChar: lines[last]!.length },
  }];

  const defs = new Map<string, number>();
  lines.forEach((text, i) => {
    const m = /^function (\w+)\(/.exec(text);
    if (!m) return;
    const end = lines.findIndex((l, j) => j > i && l === "}");
    defs.set(m[1]!, i);
    out.push({
      symbol: `${PKG}\`server.js\`/${m[1]}().`, roles: ROLE_DEFINITION,
      range: at(i, text.indexOf(m[1]!), m[1]!),
      enclosing: { startLine: i, startChar: 0, endLine: end, endChar: 1 },
    });
  });

  lines.forEach((text, i) => {
    for (const [name, defLine] of defs) {
      if (i === defLine) continue;
      for (let c = text.indexOf(`${name}(`); c !== -1; c = text.indexOf(`${name}(`, c + 1)) {
        out.push({ symbol: `${PKG}\`server.js\`/${name}().`, roles: 0, range: at(i, c, name) });
      }
    }
    // The registering call shares the handler's opening line (M7's column case).
    const reg = /^app\.(get|post)\(/.exec(text);
    if (reg) out.push({ symbol: `${FASTIFY}${reg[1]}().`, roles: 0, range: at(i, 4, reg[1]!) });
  });
  return out;
}

function bootDump(lines: string[], root: string): object {
  const entry = (position: number, phase: string, i: number) => {
    const col = lines[i]!.indexOf("async");
    return {
      position, phase, name: null, key: `${FILE}:${i + 1}:${col}`,
      file: FILE, line: i + 1, col, anonymous: true,
      origin: phase === "handler" ? "route" : "scope", declaredIn: "root", inheritedFrom: null,
    };
  };
  const hook = lines.findIndex((l) => l.startsWith("app.addHook('onRequest'"));
  const routes = lines.flatMap((text, i) => {
    const m = /^app\.(get|post)\('([^']+)'/.exec(text);
    if (!m) return [];
    const method = m[1]!.toUpperCase();
    return [{
      method, url: m[2], prefix: "", routeKey: `${REPO} ${method} ${m[2]}`,
      constraints: null, hasSchema: false, logLevel: null,
      chain: [entry(0, "onRequest", hook), entry(1, "handler", i)],
      offPath: [],
    }];
  });
  return {
    schema: "codeintel.boot.fastify/1", service: REPO, generatedAt: "2026-09-27T00:00:00Z",
    evidenceKind: "boot", confidence: "certain",
    tool: { adapter: "test", fastify: "4.28.1", fastifyOverview: null, node: "22" },
    entrypoint: FILE, repoRoot: root,
    stats: {
      routes: routes.length, chainEntries: routes.length * 2,
      anonymousChainEntries: routes.length * 2, unlocatedChainEntries: 0,
    },
    routes, overview: null, warnings: [],
  };
}

// Minimal protobuf writer for the SCIP subset ScipProtobufReader decodes (the
// same encoding python-method-calls.test.ts pins).
function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return out;
}
const bytesField = (field: number, body: number[]): number[] =>
  [...varint((field << 3) | 2), ...varint(body.length), ...body];
const stringField = (field: number, s: string): number[] =>
  bytesField(field, [...new TextEncoder().encode(s)]);
const varintField = (field: number, n: number): number[] => [...varint(field << 3), ...varint(n)];
const rangeField = (field: number, r: ScipRange): number[] => bytesField(field, (
  r.startLine === r.endLine
    ? [r.startLine, r.startChar, r.endChar]
    : [r.startLine, r.startChar, r.endLine, r.endChar]
).flatMap(varint));

function encodeIndex(projectRoot: string, occs: Occ[]): Uint8Array {
  const toolInfo = [...stringField(1, "scip-typescript"), ...stringField(2, "0.4.0")];
  const out = bytesField(1, [...bytesField(2, toolInfo), ...stringField(3, projectRoot)]);
  const doc = stringField(1, FILE);
  for (const o of occs) {
    doc.push(...bytesField(2, [
      ...rangeField(1, o.range),
      ...stringField(2, o.symbol),
      ...varintField(3, o.roles),
      ...(o.enclosing ? rangeField(7, o.enclosing) : []),
    ]));
  }
  out.push(...bytesField(2, doc));
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------

let dir: string;
let root: string;
let artifactDir: string;
let store: FactStore;
let report: IndexReport;

const repo = (): RepoConfig => ({
  name: REPO, rootPath: root, serviceName: REPO, lang: "js", framework: "fastify",
  entrypoint: FILE, include: [], exclude: [], baseUrlEnvVars: [], port: null,
  tsconfig: null, pythonBin: null,
});

/** Write one version of the service and its two artifacts, then index it. */
async function indexVersion(lines: string[], force: boolean): Promise<IndexReport> {
  writeFileSync(join(root, FILE), lines.join("\n") + "\n", "utf8");
  writeFileSync(
    join(artifactDir, "scip", `${REPO}.scip`),
    encodeIndex(pathToFileURL(root).href, occurrences(lines)),
  );
  writeFileSync(join(artifactDir, "boot", `${REPO}.json`), JSON.stringify(bootDump(lines, root)));
  return indexRepo({ store, repo: repo(), artifactDir, force });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "code-intel-handler-scope-"));
  root = join(dir, "repo");
  artifactDir = join(dir, ".codeintel");
  mkdirSync(root, { recursive: true });
  mkdirSync(join(artifactDir, "scip"), { recursive: true });
  mkdirSync(join(artifactDir, "boot"), { recursive: true });
  store = new FactStore(join(dir, "graph.db"));
  report = await indexVersion(V1, true);
});

after(() => {
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

const tier = (items: PackedItem[], t: string) => items.filter((i) => i.tier === t);
const allRoutes = (r: ReturnType<typeof impact>) =>
  [...r.routes.certain, ...r.routes.inferred, ...r.routes.unknown].map((x) => `${x.method} ${x.url}`);

describe("CTX-S10a — a call inside an anonymous handler is credited to its route", () => {
  test("the fixture reached the store with a bounded anonymous handler", () => {
    // Guards the guard: without SCIP, boot and a bounded range, every
    // assertion below would fail for a reason unrelated to attribution.
    assert.deepEqual(report.missingArtifacts, []);
    assert.equal(report.boot?.routes, 2);
    const row = store.raw().prepare(
      `SELECT rc.line, rc.end_line FROM route_chain rc
         JOIN nodes n ON n.id = rc.route_node_id
        WHERE n.key = ? AND rc.phase = 'handler'`,
    ).get(`${REPO} POST /api/v1/mail/send`) as { line: number; end_line: number } | undefined;
    assert.deepEqual({ ...row }, { line: 25, end_line: 29 });
  });

  test("context_pack lists the route as a caller, with the call's file:line", () => {
    const pack = contextPack(store, "checkUserAuth", { includeSource: false });
    const callers = tier(pack.items, "callers");
    assert.deepEqual(
      callers.map((c) => [c.kind, c.name, c.where]),
      [["route", "POST /api/v1/mail/send", `${FILE}:26`]],
      "the route, not the module, and not GET /health",
    );
    assert.match(callers[0]!.detail, /^CALLS \[certain\]/, "the underlying edge's confidence");
  });

  test("context_pack's routes tier no longer bridges through the module", () => {
    // Every route HANDLES the module (the anonymous onRequest hook joins it),
    // so HANDLES -> module -> CALLS put GET /health on checkUserAuth's routes.
    const pack = contextPack(store, "checkUserAuth", { includeSource: false });
    assert.deepEqual(tier(pack.items, "routes").map((r) => r.name), ["POST /api/v1/mail/send"]);
  });

  test("impact lists the route as a direct caller at the call site, and CERTAIN", () => {
    const r = impact(store, "checkUserAuth");
    assert.deepEqual(
      r.direct.map((s) => [s.kind, s.display, `${s.file}:${s.line}`, s.pathConfidence]),
      [["route", "POST /api/v1/mail/send", `${FILE}:26`, "certain"]],
    );
    assert.equal(r.fanIn, 1);
    // Before the fix it was reached only through the inline-check row, which
    // is `inferred`; the compiler-resolved call makes it certain.
    assert.deepEqual(r.routes.certain.map((x) => x.url), ["/api/v1/mail/send"]);
    assert.deepEqual(allRoutes(r), ["POST /api/v1/mail/send"], "GET /health does not call it");
  });

  test("a SQL literal inside the handler is no longer the file's", () => {
    const pack = contextPack(store, "checkUserAuth", { includeSource: false });
    assert.deepEqual(
      tier(pack.items, "datastores").map((d) => [d.name, d.where]),
      [["postgres://?/settings", "[file-scope]"]],
      "mail_events belongs to POST /api/v1/mail/send now; settings is still module scope",
    );
    const r = impact(store, "checkUserAuth");
    assert.deepEqual(r.data.map((d) => [d.key, d.attributedTo]), [["postgres://?/settings", "file"]]);
  });

  test("a call outside every handler range stays file-scope, and says so", () => {
    const pack = contextPack(store, "makePool", { includeSource: false });
    assert.deepEqual(
      tier(pack.items, "callers").map((c) => [c.kind, c.name, c.where]),
      [["symbol", "server.js", `${FILE}:14 [file-scope]`]],
    );
    const r = impact(store, "makePool");
    assert.deepEqual(r.direct.map((s) => [s.kind, s.display]), [["symbol", "server.js"]]);
    assert.deepEqual(allRoutes(r), []);
  });

  test("the index report counts what was credited and what is still file-scope", () => {
    assert.deepEqual(
      { calls: report.handlerScope?.calls, findings: report.handlerScope?.findings },
      {
        // checkUserAuth at 26 is credited. makePool at 14 is module scope, and
        // `get`/`post` sit on the handlers' OPENING lines, which an edge
        // without a column cannot tell from the handler's body (M7).
        calls: { credited: 1, moduleScope: 3 },
        findings: { credited: 1, fileScope: 1 },
      },
    );
    assert.deepEqual(
      report.handlerScope?.remaining.map((s) => `${s.type}@${s.line}`),
      ["CALLS@14", "READS@15", "CALLS_EXTERNAL@21", "CALLS_EXTERNAL@25"],
      "each remaining site is listed, so it can be explained",
    );
    const text = renderIndexReport([report]);
    assert.match(text, /\(1 attributed to the file — no enclosing symbol or route handler\)/);
    assert.match(text, /1 calls, 1 findings credited to anonymous route handlers/);
  });

  test("a re-index follows the call when it moves to another handler", async () => {
    // Nothing new is stored: the credit is derived from the edge and the
    // chain row at query time, and both are replaced by provenance (R28, R24).
    const second = await indexVersion(V2, false);
    assert.deepEqual(second.change.changed, [FILE]);
    const pack = contextPack(store, "checkUserAuth", { includeSource: false });
    assert.deepEqual(
      tier(pack.items, "callers").map((c) => [c.kind, c.name, c.where]),
      [["route", "GET /health", `${FILE}:22`]],
    );
    assert.deepEqual(allRoutes(impact(store, "checkUserAuth")), ["GET /health"]);
    assert.equal(second.handlerScope?.findings.credited, 1, "the INSERT, now at line 27 of POST");
  });
});

describe("CTX-S10a — confidence of a credited caller", () => {
  test("a range from a parser rather than boot makes the attribution inferred", () => {
    // No producer writes such a row today; the rule is R36's weakest link, so
    // the day one does, a parser's guess at a range cannot read as certain.
    const s = new FactStore(join(dir, "parser-range.db"));
    try {
      const repoId = s.upsertRepo("svc", "/tmp/svc", "svc");
      const runId = s.startRun(repoId, "static", "test@0", "");
      const fileId = s.upsertFile(repoId, "server.js", "js", "h", runId);
      const mod = s.upsertNode("symbol", "scip npm svc 1 `server.js`/", repoId);
      s.upsertSymbol({ nodeId: mod, fileId, displayName: "server.js", symbolKind: "namespace", startLine: 1 });
      const helper = s.upsertNode("symbol", "scip npm svc 1 `server.js`/helper().", repoId);
      s.upsertSymbol({ nodeId: helper, fileId, displayName: "helper", symbolKind: "method", startLine: 1 });
      s.insertEdge({
        srcNodeId: mod, dstNodeId: helper, type: "CALLS", confidence: "certain",
        evidenceKind: "scip", fileId, line: 12, runId,
      });
      const route = s.upsertNode("route", "svc POST /x", repoId);
      s.upsertRoute({ nodeId: route, repoId, serviceName: "svc", method: "POST", url: "/x", source: "boot", runId });
      s.insertChainEntry({
        routeNodeId: route, position: 0, phase: "handler", origin: "route", symbolNodeId: mod,
        confidence: "inferred", evidenceKind: "treesitter", fileId, line: 10, endLine: 20, runId,
      });

      const caller = tier(contextPack(s, "helper", { includeSource: false }).items, "callers")[0];
      assert.equal(caller?.name, "POST /x");
      assert.match(caller!.detail, /^CALLS \[inferred\]/);
      assert.deepEqual(impact(s, "helper").routes.inferred.map((x) => x.url), ["/x"]);
    } finally { s.close(); }
  });
});
