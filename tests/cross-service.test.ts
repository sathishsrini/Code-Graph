import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveCrossService } from "../src/derive/cross-service.ts";
import type { RepoConfig } from "../src/config/repos.ts";
import type {
  EnvBinding, FileFindings, FunctionRange, HttpFinding, UrlExpr,
} from "../src/static/treesitter/extract.ts";

// These fixtures are shaped by the corpus, not by the resolver. The earlier
// tests encoded a shape the corpus never produces — a URL two lines above its
// call in an otherwise empty file — and stayed green while P1-T7 produced zero
// edges. server.js puts every real URL one indirection above the only axios()
// call, inside `forward(...)`, and names its base variables differently from
// the env vars they read (defect 3), so the fixtures model that.

function repo(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    name: "router", rootPath: "D:/router", serviceName: "router", lang: "js",
    framework: "fastify", entrypoint: "server.js", include: ["server.js"], exclude: [],
    baseUrlEnvVars: ["ENGINE_BASE_URL", "PROCUREMENT_BASE_URL", "INTEGRATION_BASE_URL"],
    port: 3001, tsconfig: null, pythonBin: null,
    ...overrides,
  };
}

function findings(overrides: Partial<FileFindings> = {}): FileFindings {
  return {
    path: "server.js", throws: [], configs: [], datastores: [],
    https: [], urls: [], envBindings: [], functions: [], parseErrors: 0, ...overrides,
  };
}

function fn(name: string | null, line: number, endLine: number): FunctionRange {
  return { line, col: 1, endLine, name, form: "function", bodyStartLine: line };
}

function url(line: number, col: number, baseVar: string | null, literalPath: string, dynamic: boolean): UrlExpr {
  return { line, col, endLine: line, raw: "`…`", baseVar, literalPath, dynamic };
}

function http(line: number, col: number, client: string, method: string | null, urls: UrlExpr[]): HttpFinding {
  return { line, col, endLine: line, client, method, urls, configVar: null };
}

function binding(name: string, envVar: string, defaultUrl: string | null): EnvBinding {
  return {
    line: 1, col: 1, endLine: 1, name, envVar, defaultUrl,
    urlShaped: defaultUrl !== null && defaultUrl.startsWith("http"),
  };
}

const engine = repo({ name: "engine", serviceName: "engine", rootPath: "D:/engine", port: 3002, baseUrlEnvVars: [] });
const integration = repo({ name: "integration", serviceName: "integration", rootPath: "D:/integration", port: 8000, baseUrlEnvVars: [] });

describe("cross-service resolver", () => {
  test("matches an inline URL when the call is in the same function", () => {
    const result = resolveCrossService({
      repo: repo(), repos: [repo(), engine], source: "",
      targets: [{ nodeId: 7, service: "engine", method: "POST", url: "/api/v1/po/:id" }],
      findings: findings({
        https: [http(5, 2, "axios", "POST", [url(5, 12, "ENGINE_BASE_URL", "/api/v1/po/42", false)])],
        urls: [url(5, 12, "ENGINE_BASE_URL", "/api/v1/po/42", false)],
        envBindings: [binding("ENGINE_BASE_URL", "ENGINE_BASE_URL", "http://localhost:3002")],
        functions: [fn("handle", 1, 8)],
      }),
    });
    assert.deepEqual(result.requests.map((r) => r.routeNodeId), [7]);
    assert.equal(result.unresolved.length, 0);
  });

  test("resolves the corpus wrapper: URL in the caller, axios() one function below", () => {
    const source = [
      "const forward = async ({ method, url, ...r }) => axios({ method, url });",
      "async function proxyToEngine() {",
      '  const target = `${INTEGRATION_BASE_URL}/api/v1/mail/send`;',
      '  return forward({ method: "POST", url: target });',
      "}",
    ].join("\n");
    const result = resolveCrossService({
      repo: repo(), repos: [repo(), engine, integration], source,
      targets: [{ nodeId: 51, service: "integration", method: "POST", url: "/api/v1/mail/send" }],
      findings: findings({
        https: [http(1, 45, "axios", null, [])],
        urls: [url(3, 15, "INTEGRATION_BASE_URL", "/api/v1/mail/send", false)],
        envBindings: [binding("INTEGRATION_BASE_URL", "INTEGRATION_BASE_URL", "http://localhost:8000")],
        functions: [fn("forward", 1, 1), fn("proxyToEngine", 2, 5)],
      }),
    });
    assert.deepEqual(result.requests.map((r) => ({ node: r.routeNodeId, line: r.line })), [{ node: 51, line: 3 }]);
    assert.equal(result.unresolved.length, 0);
  });

  test("never binds a URL to the nearest preceding expression", () => {
    const source = [
      "fastify.options('/*', async (req, reply) => reply.status(204).send());",
      "async function proxyAuth() {",
      "  const target = `${ENGINE_BASE_URL}${path}`;",
      "  return forward({ url: target });",
      "}",
      "const forward = async ({ url }) => axios({ url });",
    ].join("\n");
    const result = resolveCrossService({
      repo: repo(), repos: [repo(), engine], source,
      targets: [{ nodeId: 8, service: "engine", method: "GET", url: "/health" }],
      findings: findings({
        https: [http(6, 36, "axios", null, [])],
        urls: [url(1, 17, null, "/*", false), url(3, 15, "ENGINE_BASE_URL", "", true)],
        envBindings: [binding("ENGINE_BASE_URL", "ENGINE_BASE_URL", "http://localhost:3002")],
        functions: [fn(null, 1, 1), fn("proxyAuth", 2, 5), fn("forward", 6, 6)],
      }),
    });
    assert.equal(result.requests.length, 0);
    // The route-registration string '/*' is a bare path literal (no base, no
    // host, no client call): classified as a path, not a URL, so it produces
    // neither a request nor a phantom gap.
    assert.ok(!result.unresolved.some((u) => u.targetHint === "/*"));
    // The real dynamic URL is an honest gap, not a silent absence.
    assert.ok(result.unresolved.some((u) => u.line === 3 && /dynamic path/.test(u.reason)));
  });

  test("resolves a local base name through its env binding (BASE != env var)", () => {
    const source = [
      "const BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3001';",
      "async function request() {",
      "  return fetch(`${BASE}/api/v1/po/42`);",
      "}",
    ].join("\n");
    const frontend = repo({
      name: "frontend", serviceName: "frontend", port: 3000,
      baseUrlEnvVars: ["NEXT_PUBLIC_API_BASE_URL"],
    });
    const result = resolveCrossService({
      repo: frontend, repos: [frontend, repo(), engine, integration], source,
      targets: [{ nodeId: 7, service: "router", method: "GET", url: "/api/v1/po/:id" }],
      findings: findings({
        https: [http(3, 14, "fetch", null, [url(3, 14, "BASE", "/api/v1/po/42", false)])],
        urls: [url(3, 14, "BASE", "/api/v1/po/42", false)],
        envBindings: [binding("BASE", "NEXT_PUBLIC_API_BASE_URL", "http://localhost:3001")],
        functions: [fn("request", 2, 4)],
      }),
    });
    assert.deepEqual(result.requests.map((r) => r.routeNodeId), [7]);
    assert.equal(result.unresolved.length, 0);
  });

  test("does not resolve a non-loopback host by port alone", () => {
    const source = [
      "async function pay() {",
      "  await fetch('https://api.stripe.com:3002/x');",
      "}",
    ].join("\n");
    const result = resolveCrossService({
      repo: repo(), repos: [repo(), engine], source,
      targets: [{ nodeId: 9, service: "engine", method: "POST", url: "/x" }],
      findings: findings({
        https: [http(2, 14, "fetch", null, [url(2, 14, null, "https://api.stripe.com:3002/x", false)])],
        urls: [url(2, 14, null, "https://api.stripe.com:3002/x", false)],
        functions: [fn("pay", 1, 3)],
      }),
    });
    assert.equal(result.requests.length, 0);
    assert.ok(result.unresolved.some((u) => /not the loopback host/.test(u.reason)));
  });

  test("an env-conditional ternary yields explicit gaps, never silence", () => {
    const source = [
      "const PROCUREMENT_BASE_URL = process.env.PROCUREMENT_BASE_URL || '';",
      "const ENGINE_BASE_URL = process.env.ENGINE_BASE_URL || 'http://localhost:3002';",
      "async function proxyToEngine(req) {",
      "  const isProcurementPath = true;",
      "  const target = (PROCUREMENT_BASE_URL && isProcurementPath) ? `${PROCUREMENT_BASE_URL}${req.url}` : `${ENGINE_BASE_URL}${req.url}`;",
      "  return forward({ method: req.method, url: target });",
      "}",
      "const forward = async ({ method, url }) => axios({ method, url });",
    ].join("\n");
    const result = resolveCrossService({
      repo: repo(), repos: [repo(), engine, integration], source,
      targets: [{ nodeId: 12, service: "engine", method: "POST", url: "/api/v1/po" }],
      findings: findings({
        https: [http(8, 45, "axios", null, [])],
        urls: [url(5, 52, "PROCUREMENT_BASE_URL", "", true), url(5, 92, "ENGINE_BASE_URL", "", true)],
        envBindings: [
          binding("PROCUREMENT_BASE_URL", "PROCUREMENT_BASE_URL", ""),
          binding("ENGINE_BASE_URL", "ENGINE_BASE_URL", "http://localhost:3002"),
        ],
        functions: [fn("proxyToEngine", 3, 7), fn("forward", 8, 8)],
      }),
    });
    // Two candidates on one line -> no invented winner.
    assert.equal(result.requests.length, 0);
    assert.equal(result.unresolved.length, 2);
    assert.ok(result.unresolved.some((u) => /no indexed service/.test(u.reason)));
    assert.ok(result.unresolved.some((u) => /dynamic path/.test(u.reason)));
  });

  test("a URL outside any function body is reported, not resolved", () => {
    const result = resolveCrossService({
      repo: repo(), repos: [repo(), engine], source: "",
      targets: [],
      findings: findings({ urls: [url(1, 40, null, "http://localhost:3000", false)] }),
    });
    assert.equal(result.requests.length, 0);
    assert.ok(result.unresolved.some((u) => /outside any function body/.test(u.reason)));
  });

  test("a bare-path comparison inside a consumed function stays silent", () => {
    const source = [
      "async function proxyToEngine(req) {",
      "  const tree = req.url.startsWith('/api/v1/po');",
      "  return forward({ method: req.method, url: `${ENGINE_BASE_URL}${req.url}` });",
      "}",
      "const forward = async ({ method, url }) => axios({ method, url });",
    ].join("\n");
    const result = resolveCrossService({
      repo: repo(), repos: [repo(), engine], source,
      targets: [{ nodeId: 12, service: "engine", method: "GET", url: "/api/v1/po" }],
      findings: findings({
        https: [http(5, 45, "axios", null, [])],
        // The startsWith('/api/v1/po') literal is not a URL; the template is.
        urls: [url(2, 19, null, "/api/v1/po", false), url(3, 15, "ENGINE_BASE_URL", "", true)],
        envBindings: [binding("ENGINE_BASE_URL", "ENGINE_BASE_URL", "http://localhost:3002")],
        functions: [fn("proxyToEngine", 1, 4), fn("forward", 5, 5)],
      }),
    });
    assert.equal(result.requests.length, 0);
    assert.ok(!result.unresolved.some((u) => u.targetHint === "/api/v1/po"));
    assert.ok(result.unresolved.some((u) => u.line === 3 && /dynamic path/.test(u.reason)));
  });

  test("a config-style client call with no URL anywhere is named as such", () => {
    const result = resolveCrossService({
      repo: repo(), repos: [repo(), engine], source: "",
      targets: [],
      findings: findings({
        https: [{ line: 1, col: 1, endLine: 1, client: "axios", method: null, urls: [], configVar: "axiosConfig" }],
      }),
    });
    assert.equal(result.requests.length, 0);
    assert.ok(result.unresolved.some((u) => /no URL expression anywhere/.test(u.reason)));
  });
});