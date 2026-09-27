// CTX-S12 — frontend -> backend through a URL wrapper.
//
// The corpus gap (plan §2.5): `60-kri-next/lib/api.ts` binds
// `BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3001"` and
// calls `fetch(`${BASE}${path}`, …)` inside a wrapper, with `path` passed in by
// callers across app/ and components/. Per file, `path` is a parameter, so the
// linker wrote one "dynamic path" gap and 0 REQUESTS edges.
//
// The fixture mirrors that shape, including the part M2/M3 recorded about the
// real file: object-literal helpers (`api.get`, `api.post`) that call the
// wrapper, whose own callers are the 11 frontend call sites. It runs the real
// path end to end: sources on disk -> SCIP bytes on disk -> indexRepo ->
// linkCrossServiceRepos -> the store, so the confidence asserted below is the
// one a query reads, not a field on an in-memory object.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { FactStore } from "../src/store/db.ts";
import { GraphWriter } from "../src/normalize/graph.ts";
import { ref } from "../src/normalize/keys.ts";
import { indexRepo, linkCrossServiceRepos } from "../src/index/pipeline.ts";
import { collectPathWrappers, resolveCrossService } from "../src/derive/cross-service.ts";
import { parseFile } from "../src/static/treesitter/parser.ts";
import { extract } from "../src/static/treesitter/extract.ts";
import type { RepoConfig } from "../src/config/repos.ts";
import type { ScipRange } from "../src/static/scip/reader.ts";
import { ROLE_DEFINITION, ROLE_IMPORT } from "../src/static/scip/reader.ts";

// ---------------------------------------------------------------------------
// Fixture sources. Line numbers in comments are 0-based, as SCIP counts.
// ---------------------------------------------------------------------------

const API_TS = "lib/api.ts";
const NEW_PAGE = "app/po/new/page.tsx";
const LIST_PAGE = "app/po/page.tsx";
const DETAIL = "components/PoDetail.tsx";

const SOURCES: Record<string, string[]> = {
  [API_TS]: [
    "// Shaped like 60-kri-next/lib/api.ts (M2, M3): an env-bound base, one",
    "// fetch wrapper, and object-literal helpers that call it.",
    'const BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3001";', // 2
    "",
    "export async function apiFetch(path: string, init?: RequestInit) {",              // 4
    '  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "Content-Type": "application/json" } });',
    "  return res.json();",
    "}",
    "",
    "export const api = {",                                                             // 9
    "  get: (path: string) => apiFetch(path),",                                         // 10
    '  post: (path: string, body: unknown) => apiFetch(path, { method: "POST", body: JSON.stringify(body) }),',
    "};",
  ],
  [NEW_PAGE]: [
    'import { apiFetch } from "@/lib/api";',
    "",
    "export default function NewPoPage() {",                                            // 2
    "  async function submit(body: unknown) {",
    '    await apiFetch("/api/v1/po", { method: "POST", body: JSON.stringify(body) });', // 4
    "  }",
    "  return <form onSubmit={() => submit({})} />;",
    "}",
  ],
  [LIST_PAGE]: [
    'import { api } from "@/lib/api";',
    "",
    "export default function PoListPage() {",                                           // 2
    '  const refresh = () => api.get("/api/v1/po");',                                   // 3
    '  const create = (body: unknown) => api.post("/api/v1/po", body);',                // 4
    "  return <button onClick={() => { refresh(); create({}); }} />;",
    "}",
  ],
  [DETAIL]: [
    'import { apiFetch } from "@/lib/api";',
    "",
    "export function PoDetail({ id, kind }: { id: string; kind: string }) {",           // 2
    "  const load = () => apiFetch(`/api/v1/po/${id}`);",                               // 3
    '  const url = "/api/v1/" + kind;',
    "  const other = () => apiFetch(url);",                                             // 5
    "  return <div onClick={() => { load(); other(); }} />;",
    "}",
  ],
};

// ---------------------------------------------------------------------------
// The scip-typescript transcript. Symbols follow the real index's grammar
// (tests/scip-symbol.test.ts, M3: `api.get(...)` resolves to
// ``lib/`api.ts`/get0:``). Offsets are computed from SOURCES, never counted.
// ---------------------------------------------------------------------------

const PKG = "scip-typescript npm web 0.1.0 ";
const API = PKG + "lib/`api.ts`/";
const API_FETCH = API + "apiFetch().";
const API_OBJ = API + "api.";
const API_GET = API + "get0:";
const API_POST = API + "post0:";
const NEW_PAGE_FN = PKG + "app/po/new/`page.tsx`/NewPoPage().";
const LIST_PAGE_FN = PKG + "app/po/`page.tsx`/PoListPage().";
const DETAIL_FN = PKG + "components/`PoDetail.tsx`/PoDetail().";

interface Occ { symbol: string; roles: number; range: ScipRange; enclosing?: ScipRange }

/** The range of `name`, found after `before` on a line. */
function at(path: string, line: number, name: string, before = ""): ScipRange {
  const text = SOURCES[path]![line]!;
  const start = text.indexOf(before + name);
  assert.notEqual(start, -1, `"${before + name}" not on ${path}:${line}: ${text}`);
  const from = start + before.length;
  return { startLine: line, startChar: from, endLine: line, endChar: from + name.length };
}

function body(path: string, from: number, to: number): ScipRange {
  const lines = SOURCES[path]!;
  return { startLine: from, startChar: 0, endLine: to, endChar: lines[to]!.length };
}

const DEF = ROLE_DEFINITION;
const REF = 0;

function occurrences(): Record<string, Occ[]> {
  return {
    [API_TS]: [
      { symbol: API + "BASE.", roles: DEF, range: at(API_TS, 2, "BASE") },
      { symbol: API_FETCH, roles: DEF, range: at(API_TS, 4, "apiFetch"), enclosing: body(API_TS, 4, 7) },
      { symbol: API + "BASE.", roles: REF, range: at(API_TS, 5, "BASE") },
      { symbol: API_OBJ, roles: DEF, range: at(API_TS, 9, "api") },
      { symbol: API_GET, roles: DEF, range: at(API_TS, 10, "get") },
      { symbol: API_FETCH, roles: REF, range: at(API_TS, 10, "apiFetch") },
      { symbol: API_POST, roles: DEF, range: at(API_TS, 11, "post") },
      { symbol: API_FETCH, roles: REF, range: at(API_TS, 11, "apiFetch") },
    ],
    [NEW_PAGE]: [
      { symbol: API_FETCH, roles: ROLE_IMPORT, range: at(NEW_PAGE, 0, "apiFetch") },
      { symbol: NEW_PAGE_FN, roles: DEF, range: at(NEW_PAGE, 2, "NewPoPage"), enclosing: body(NEW_PAGE, 2, 7) },
      { symbol: "local 0", roles: DEF, range: at(NEW_PAGE, 3, "submit") },
      { symbol: API_FETCH, roles: REF, range: at(NEW_PAGE, 4, "apiFetch") },
    ],
    [LIST_PAGE]: [
      { symbol: API_OBJ, roles: ROLE_IMPORT, range: at(LIST_PAGE, 0, "api") },
      { symbol: LIST_PAGE_FN, roles: DEF, range: at(LIST_PAGE, 2, "PoListPage"), enclosing: body(LIST_PAGE, 2, 6) },
      { symbol: API_OBJ, roles: REF, range: at(LIST_PAGE, 3, "api", "=> ") },
      { symbol: API_GET, roles: REF, range: at(LIST_PAGE, 3, "get", "api.") },
      { symbol: API_OBJ, roles: REF, range: at(LIST_PAGE, 4, "api", "=> ") },
      { symbol: API_POST, roles: REF, range: at(LIST_PAGE, 4, "post", "api.") },
    ],
    [DETAIL]: [
      { symbol: API_FETCH, roles: ROLE_IMPORT, range: at(DETAIL, 0, "apiFetch") },
      { symbol: DETAIL_FN, roles: DEF, range: at(DETAIL, 2, "PoDetail"), enclosing: body(DETAIL, 2, 7) },
      { symbol: API_FETCH, roles: REF, range: at(DETAIL, 3, "apiFetch") },
      { symbol: API_FETCH, roles: REF, range: at(DETAIL, 5, "apiFetch") },
    ],
  };
}

// Minimal protobuf writer for the SCIP subset ScipProtobufReader decodes (the
// same one tests/python-method-calls.test.ts uses), so the index reaches the
// pipeline as bytes on disk, as a real one does.

function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return out;
}
const bytesField = (field: number, bytes: number[]): number[] =>
  [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];
const stringField = (field: number, s: string): number[] =>
  bytesField(field, [...new TextEncoder().encode(s)]);
const varintField = (field: number, n: number): number[] => [...varint(field << 3), ...varint(n)];
const rangeField = (field: number, r: ScipRange): number[] => bytesField(field, (
  r.startLine === r.endLine
    ? [r.startLine, r.startChar, r.endChar]
    : [r.startLine, r.startChar, r.endLine, r.endChar]
).flatMap(varint));

function encodeIndex(projectRoot: string, docs: Record<string, Occ[]>): Uint8Array {
  const toolInfo = [...stringField(1, "scip-typescript"), ...stringField(2, "0.3.14")];
  const metadata = [...bytesField(2, toolInfo), ...stringField(3, projectRoot)];
  const out = bytesField(1, metadata);
  for (const [path, occs] of Object.entries(docs)) {
    const doc = stringField(1, path);
    for (const o of occs) {
      doc.push(...bytesField(2, [
        ...rangeField(1, o.range),
        ...stringField(2, o.symbol),
        ...varintField(3, o.roles),
        ...(o.enclosing ? rangeField(7, o.enclosing) : []),
      ]));
    }
    out.push(...bytesField(2, doc));
  }
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// Two workspaces: one with the frontend's SCIP index, one without it.
// ---------------------------------------------------------------------------

const ROUTES: Array<[string, string]> = [
  ["POST", "/api/v1/po"],
  // Not in the slice's minimum target set. Present because the corpus router
  // has a list route, and a `/api/v1/po/${id}` template must not land on it.
  ["GET", "/api/v1/po"],
  ["GET", "/api/v1/po/:id"],
];

interface Workspace { dir: string; store: FactStore }

async function workspace(withScip: boolean): Promise<Workspace> {
  const dir = mkdtempSync(join(tmpdir(), "code-intel-ctx-s12-"));
  const webRoot = join(dir, "web");
  const routerRoot = join(dir, "router");
  mkdirSync(routerRoot, { recursive: true });
  for (const [path, lines] of Object.entries(SOURCES)) {
    mkdirSync(dirname(join(webRoot, path)), { recursive: true });
    writeFileSync(join(webRoot, path), lines.join("\n") + "\n", "utf8");
  }
  const artifactDir = join(dir, ".codeintel");
  mkdirSync(join(artifactDir, "scip"), { recursive: true });
  if (withScip) {
    writeFileSync(join(artifactDir, "scip", "web.scip"), encodeIndex(pathToFileURL(webRoot).href, occurrences()));
  }

  const web: RepoConfig = {
    name: "web", rootPath: webRoot, serviceName: "web", lang: "ts", framework: "nextjs",
    entrypoint: "", include: ["app/**", "components/**", "lib/**"], exclude: [],
    baseUrlEnvVars: ["NEXT_PUBLIC_API_BASE_URL"], port: 3000, tsconfig: null, pythonBin: null,
  };
  const router: RepoConfig = {
    name: "router", rootPath: routerRoot, serviceName: "router", lang: "js", framework: "fastify",
    entrypoint: "server.js", include: [], exclude: [], baseUrlEnvVars: [], port: 3001,
    tsconfig: null, pythonBin: null,
  };

  const store = new FactStore(join(dir, "graph.db"));
  await indexRepo({ store, repo: web, artifactDir, force: true });

  // The router's boot routes, written the way expandRoutes writes them.
  const routerId = store.upsertRepo(router.name, router.rootPath, router.serviceName);
  const runId = store.startRun(routerId, "boot", "test", "");
  const writer = new GraphWriter(store, runId, routerId, { localPackages: new Set(["router"]) });
  for (const [method, url] of ROUTES) {
    const nodeId = writer.node(ref.route("router", method, url));
    store.upsertRoute({ nodeId, repoId: routerId, serviceName: "router", method, url, source: "boot", runId });
  }
  store.finishRun(runId);

  await linkCrossServiceRepos({ store, repos: [web, router], artifactDir });
  return { dir, store };
}

interface RequestRow { src: string; dst: string; confidence: string; path: string; line: number; detail: string }
interface GapRow { path: string; line: number; hint: string; reason: string }

function requests(store: FactStore): RequestRow[] {
  return store.raw().prepare(
    `SELECT s.key AS src, d.key AS dst, e.confidence AS confidence,
            f.path AS path, e.line AS line, e.detail AS detail
       FROM edges e
       JOIN nodes s ON s.id = e.src_node_id
       JOIN nodes d ON d.id = e.dst_node_id
       JOIN files f ON f.id = e.file_id
      WHERE e.type = 'REQUESTS'
      ORDER BY f.path, e.line`,
  ).all() as unknown as RequestRow[];
}

function gaps(store: FactStore): GapRow[] {
  return store.raw().prepare(
    `SELECT f.path AS path, u.line AS line, u.target_hint AS hint, u.reason AS reason
       FROM unresolved_calls u JOIN files f ON f.id = u.file_id
      WHERE u.kind = 'cross_service'
      ORDER BY f.path, u.line`,
  ).all() as unknown as GapRow[];
}

const routeKey = (method: string, url: string): string => ref.route("router", method, url).key;

// ---------------------------------------------------------------------------

describe("CTX-S12: a URL wrapper's path parameter traced to its callers", () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(true); });
  after(() => { ws?.store.close(); if (ws) rmSync(ws.dir, { recursive: true, force: true }); });

  test("a literal path at a wrapper call site becomes an inferred REQUESTS edge", () => {
    const edge = requests(ws.store).find((r) => r.path === NEW_PAGE);
    assert.ok(edge, `apiFetch("/api/v1/po", { method: "POST" }) in ${NEW_PAGE} has an edge`);
    assert.equal(edge.dst, routeKey("POST", "/api/v1/po"));
    assert.equal(edge.line, 5, "the edge sits at the call site, not inside the wrapper");
    assert.equal(edge.src, NEW_PAGE_FN, "owned by the calling component's SCIP symbol, verbatim");
    // The base comes from the env binding's loopback default. The env var may
    // point elsewhere at runtime, so the edge is inferred and says why.
    assert.equal(edge.confidence, "inferred");
    assert.match(edge.detail, /method POST from the call site's options/);
    assert.match(edge.detail, /NEXT_PUBLIC_API_BASE_URL/);
    assert.match(edge.detail, /localhost:3001/);
    assert.match(edge.detail, /may point elsewhere at runtime/);
    assert.match(edge.detail, /§4\.2/);
  });

  test("wrappers that pass their own path parameter on are traced through (api.get / api.post)", () => {
    const list = requests(ws.store).filter((r) => r.path === LIST_PAGE);
    assert.deepEqual(
      list.map((r) => [r.line, r.dst, r.confidence]),
      [
        [4, routeKey("GET", "/api/v1/po"), "inferred"],
        [5, routeKey("POST", "/api/v1/po"), "inferred"],
      ],
    );
    // No method at the call site, none in get()'s call to apiFetch, none in
    // fetch's own options: fetch's default applies, and the detail says so.
    assert.match(list[0]!.detail, /method GET from fetch's default/);
    // post() states the method in the options it passes to apiFetch().
    assert.match(list[1]!.detail, /method POST from post\(\)'s call to apiFetch\(\) \(lib\/api\.ts:12\)/);
    assert.match(list[1]!.detail, /post\(\) lib\/api\.ts:12 -> apiFetch\(\) lib\/api\.ts:6/);
    for (const r of list) assert.equal(r.src, LIST_PAGE_FN);
  });

  test("a template or variable path argument stays a gap, with its own reason", () => {
    const detail = gaps(ws.store).filter((g) => g.path === DETAIL);
    assert.equal(detail.length, 2);
    const [template, variable] = detail;
    assert.equal(template!.line, 4);
    assert.match(template!.reason, /template/);
    assert.match(template!.reason, /\/api\/v1\/po\//);
    assert.equal(variable!.line, 6);
    assert.match(variable!.reason, /`url` is a variable, not a literal/);
    // Neither became an edge: in particular the template's literal prefix is
    // not taken as the whole path, which would land on GET /api/v1/po.
    assert.equal(requests(ws.store).filter((r) => r.path === DETAIL).length, 0);
  });

  test("the wrapper's own dynamic URL is replaced by its call sites, not double counted", () => {
    assert.deepEqual(gaps(ws.store).filter((g) => g.path === API_TS), []);
    assert.deepEqual(requests(ws.store).filter((r) => r.path === API_TS), []);
  });

  test("fixture totals: 3 resolved, 2 unresolved", () => {
    assert.equal(requests(ws.store).length, 3);
    assert.equal(gaps(ws.store).length, 2);
  });
});

describe("CTX-S12: without a SCIP index the wrapper keeps an explicit gap", () => {
  let ws: Workspace;
  before(async () => { ws = await workspace(false); });
  after(() => { ws?.store.close(); if (ws) rmSync(ws.dir, { recursive: true, force: true }); });

  test("callers cannot be identified, so nothing is guessed by name and the gap stays", () => {
    assert.equal(requests(ws.store).length, 0);
    const rows = gaps(ws.store);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.path, API_TS);
    assert.equal(rows[0]!.line, 6);
    assert.match(rows[0]!.reason, /parameter `path` of apiFetch\(\)/);
    assert.match(rows[0]!.reason, /SCIP/);
  });
});

describe("CTX-S12: the GET default is used only when every method source is visible", () => {
  test("options built in a local make the method unknown, never GET", async () => {
    const lines = [
      'const BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3001";',
      "export async function send(path: string, init?: RequestInit) {",
      '  const opts = { ...init, headers: { a: "b" } };',
      "  return fetch(`${BASE}${path}`, opts);",
      "}",
      "export async function create() {",
      '  return send("/api/v1/po", { method: "POST" });',
      "}",
    ];
    const parsed = await parseFile("lib/client.ts", lines.join("\n"));
    assert.ok(parsed);
    const findings = extract(parsed);
    // SCIP, reduced to the two occurrences that matter: send's definition and
    // the reference at its call. Columns found, not counted.
    const SEND = "scip-typescript npm web 0.1.0 lib/`client.ts`/send().";
    const occ = new Map([
      [`2:${lines[1]!.indexOf("send")}`, SEND],
      [`7:${lines[6]!.indexOf("send")}`, SEND],
    ]);
    const wrappers = collectPathWrappers([findings], (path, line, col) =>
      path === "lib/client.ts" ? occ.get(`${line}:${col}`) ?? null : null);

    const frontend: RepoConfig = {
      name: "web", rootPath: "/web", serviceName: "web", lang: "ts", framework: "nextjs",
      entrypoint: "", include: [], exclude: [], baseUrlEnvVars: ["NEXT_PUBLIC_API_BASE_URL"],
      port: 3000, tsconfig: null, pythonBin: null,
    };
    const router: RepoConfig = { ...frontend, name: "router", serviceName: "router", baseUrlEnvVars: [], port: 3001 };
    const result = resolveCrossService({
      repo: frontend, repos: [frontend, router], source: lines.join("\n"), findings, wrappers,
      targets: [
        { nodeId: 1, service: "router", method: "GET", url: "/api/v1/po" },
        { nodeId: 2, service: "router", method: "POST", url: "/api/v1/po" },
      ],
    });
    // The caller's POST never reaches fetch (opts is rebuilt locally), and
    // defaulting to GET would be a false edge. Path-only: two candidates.
    assert.deepEqual(result.requests, []);
    assert.equal(result.unresolved.length, 1);
    assert.equal(result.unresolved[0]!.line, 7);
    assert.match(result.unresolved[0]!.reason, /ambiguous route match \(2 candidates\)/);
    assert.match(result.unresolved[0]!.reason, /`opts`, a local the linker does not follow/);
  });
});

describe("CTX-S12: a dynamic segment inside the path is never matched by its prefix", () => {
  test("`${BASE}/api/v1/po/${id}` does not land on GET /api/v1/po", () => {
    const frontend: RepoConfig = {
      name: "web", rootPath: "/web", serviceName: "web", lang: "ts", framework: "nextjs",
      entrypoint: "", include: [], exclude: [], baseUrlEnvVars: ["NEXT_PUBLIC_API_BASE_URL"],
      port: 3000, tsconfig: null, pythonBin: null,
    };
    const router: RepoConfig = { ...frontend, name: "router", serviceName: "router", baseUrlEnvVars: [], port: 3001 };
    const url = {
      line: 3, col: 15, endLine: 3, raw: "`${BASE}/api/v1/po/${id}`",
      baseVar: "BASE", literalPath: "/api/v1/po/", dynamic: true,
    };
    const result = resolveCrossService({
      repo: frontend, repos: [frontend, router], source: "",
      targets: [
        { nodeId: 1, service: "router", method: "GET", url: "/api/v1/po" },
        { nodeId: 2, service: "router", method: "GET", url: "/api/v1/po/:id" },
      ],
      findings: {
        path: "lib/po.ts", throws: [], configs: [], datastores: [], parseErrors: 0,
        https: [{ line: 3, col: 9, endLine: 3, client: "fetch", method: "GET", urls: [url], configVar: null }],
        urls: [url],
        envBindings: [{
          line: 1, col: 0, endLine: 1, name: "BASE", envVar: "NEXT_PUBLIC_API_BASE_URL",
          defaultUrl: "http://localhost:3001", urlShaped: true,
        }],
        functions: [{ line: 2, col: 0, endLine: 4, name: "loadPo", form: "function", bodyStartLine: 2 }],
        calls: [],
      },
    });
    assert.deepEqual(result.requests, []);
    assert.equal(result.unresolved.length, 1);
    assert.match(result.unresolved[0]!.reason, /dynamic/);
  });

  test("a dynamic query string still matches the path it follows", () => {
    const frontend: RepoConfig = {
      name: "web", rootPath: "/web", serviceName: "web", lang: "ts", framework: "nextjs",
      entrypoint: "", include: [], exclude: [], baseUrlEnvVars: ["NEXT_PUBLIC_API_BASE_URL"],
      port: 3000, tsconfig: null, pythonBin: null,
    };
    const router: RepoConfig = { ...frontend, name: "router", serviceName: "router", baseUrlEnvVars: [], port: 3001 };
    const url = {
      line: 3, col: 15, endLine: 3, raw: "`${BASE}/api/v1/po?status=${s}`",
      baseVar: "BASE", literalPath: "/api/v1/po?status=", dynamic: true,
    };
    const result = resolveCrossService({
      repo: frontend, repos: [frontend, router], source: "",
      targets: [{ nodeId: 1, service: "router", method: "GET", url: "/api/v1/po" }],
      findings: {
        path: "lib/po.ts", throws: [], configs: [], datastores: [], parseErrors: 0,
        https: [{ line: 3, col: 9, endLine: 3, client: "fetch", method: "GET", urls: [url], configVar: null }],
        urls: [url],
        envBindings: [{
          line: 1, col: 0, endLine: 1, name: "BASE", envVar: "NEXT_PUBLIC_API_BASE_URL",
          defaultUrl: "http://localhost:3001", urlShaped: true,
        }],
        functions: [{ line: 2, col: 0, endLine: 4, name: "listPos", form: "function", bodyStartLine: 2 }],
        calls: [],
      },
    });
    assert.deepEqual(result.requests.map((r) => r.routeNodeId), [1]);
  });
});
