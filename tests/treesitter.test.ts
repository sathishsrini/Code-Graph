// Tests for the tree-sitter pass (task P1-T6, R19).
//
// Written against the idioms the validation corpus actually uses, not against
// idealised examples. The two that matter most:
//
//   `axios(axiosConfig)` — the URL is one indirection away from the call
//   `(A && cond) ? \`${A}${x}\` : \`${B}${x}\`` — two destinations, one site
//
// Both are in `40-kri-router/server.js`, and both are cases where returning a
// single confident answer would be wrong.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseFile } from "../src/static/treesitter/parser.ts";
import { extract, readSql, enclosingFunction } from "../src/static/treesitter/extract.ts";
import type { FileFindings } from "../src/static/treesitter/extract.ts";

async function scan(path: string, source: string): Promise<FileFindings> {
  const parsed = await parseFile(path, source);
  assert.ok(parsed, `${path} should parse`);
  return extract(parsed);
}

describe("readSql", () => {
  const cases: Array<[string, string | null, string]> = [
    ["SELECT * FROM users WHERE email=$1", "users", "read"],
    ["INSERT INTO mail_events (id, event_type) VALUES ($1,$2)", "mail_events", "write"],
    ["UPDATE purchase_orders SET status=$1 WHERE id=$2", "purchase_orders", "write"],
    ["DELETE FROM bills WHERE id=$1", "bills", "write"],
    ["  select id from Goods_Receipts ", "goods_receipts", "read"],
    ["SELECT 1", null, ""],
    ["Content-Type", null, ""],
    ["/api/v1/po", null, ""],
  ];
  for (const [sql, table, operation] of cases) {
    test(`${JSON.stringify(sql.slice(0, 34))} -> ${table ?? "not sql"}`, () => {
      const got = readSql(sql);
      if (table === null) { assert.equal(got, null); return; }
      assert.equal(got?.table, table);
      assert.equal(got?.operation, operation);
    });
  }

  test("a table name is lower-cased and unquoted so both writers agree", () => {
    // OPEN-9 rests on this: 51-integration writes `mail_events` and
    // 41-kri-engine's migration creates `mail_events`. Different casing or a
    // surviving quote would give them two datastore nodes and no coupling.
    assert.equal(readSql('INSERT INTO "MAIL_EVENTS" (id) VALUES (1)')?.table, "mail_events");
  });
});

describe("config reads (R19, R23)", () => {
  test("finds process.env in all three JS forms", async () => {
    const f = await scan("a.js", [
      "const PORT = parseInt(process.env.PORT || '3001', 10);",
      "const k = process.env['SERVICE_TOKEN'];",
      "if (process.env.NODE_ENV === 'production') {}",
    ].join("\n"));
    assert.deepEqual(f.configs.map((c) => c.varName).sort(), ["NODE_ENV", "PORT", "SERVICE_TOKEN"]);
  });

  test("finds os.getenv and os.environ in Python", async () => {
    const f = await scan("a.py", [
      'PORT = int(os.getenv("PORT", "8000"))',
      'k = os.environ["SERVICE_TOKEN"]',
      'v = os.environ.get("DATABASE_HOST")',
    ].join("\n"));
    assert.deepEqual(f.configs.map((c) => c.varName).sort(),
      ["DATABASE_HOST", "PORT", "SERVICE_TOKEN"]);
  });

  test("a header read is not an env read", async () => {
    // `request.headers.get("authorization", "")` matches on method name alone.
    // Without checking the receiver, the linker acquires a destination named
    // `auth` — which is how a plausible-looking wrong answer gets into a graph.
    const f = await scan("a.py", 'auth = request.headers.get("authorization", "")');
    assert.deepEqual(f.configs, []);
    assert.deepEqual(f.envBindings, []);
  });
});

describe("outbound HTTP", () => {
  test("axios(config) records the config identifier, not an empty finding", async () => {
    // server.js:68. `forward()` is the router's only outbound call site and
    // its URL is built by its caller. A finding with no URL and no identifier
    // is indistinguishable from "this call has no destination".
    const f = await scan("server.js", [
      "async function forward({ method, url }) {",
      "  const axiosConfig = { method, url };",
      "  return axios(axiosConfig);",
      "}",
    ].join("\n"));
    assert.equal(f.https.length, 1);
    assert.equal(f.https[0]!.client, "axios");
    assert.equal(f.https[0]!.configVar, "axiosConfig");
    assert.equal(f.https[0]!.urls.length, 0);
  });

  test("axios.post(url) records client, method and url together", async () => {
    const f = await scan("a.js", "await axios.post(`${BASE}/api/v1/mail/send`, body);");
    const h = f.https[0]!;
    assert.equal(h.client, "axios");
    assert.equal(h.method, "POST");
    assert.equal(h.urls[0]?.baseVar, "BASE");
    assert.equal(h.urls[0]?.literalPath, "/api/v1/mail/send");
  });

  test("a method given as an object property is read", async () => {
    const f = await scan("a.js", "await axios({ method: 'put', url: `${BASE}/x` });");
    assert.equal(f.https[0]?.method, "PUT");
  });

  test("Python httpx and requests resolve through the module name", async () => {
    const f = await scan("a.py", [
      'r = httpx.post("http://localhost:3002/api/v1/po", json=body)',
      'q = requests.get("http://localhost:8000/health")',
    ].join("\n"));
    assert.deepEqual(f.https.map((h) => `${h.client}.${h.method}`), ["httpx.POST", "requests.GET"]);
  });
});

describe("URL expressions", () => {
  test("an env-conditional ternary yields TWO candidates, not one winner", async () => {
    // OPEN-4, and doc §Q.1's "#1 source of wrong cross-service edges". Picking
    // either branch produces one confident, silently-wrong edge; the linker
    // needs both so it can emit two candidates or one unresolved row.
    const f = await scan("server.js",
      "const target = (PROCUREMENT_BASE_URL && isP) ? `${PROCUREMENT_BASE_URL}${req.url}` " +
      ": `${ENGINE_BASE_URL}${req.url}`;");
    const bases = f.urls.map((u) => u.baseVar).sort();
    assert.deepEqual(bases, ["ENGINE_BASE_URL", "PROCUREMENT_BASE_URL"]);
    assert.ok(f.urls.every((u) => u.dynamic), "req.url makes the path unknowable statically");
    assert.ok(f.urls.every((u) => u.literalPath === ""));
  });

  test("a literal path after a base var is captured whole", async () => {
    const f = await scan("a.js", "const u = `${INTEGRATION_BASE_URL}/api/v1/mail/send`;");
    assert.equal(f.urls.length, 1);
    assert.equal(f.urls[0]!.baseVar, "INTEGRATION_BASE_URL");
    assert.equal(f.urls[0]!.literalPath, "/api/v1/mail/send");
    assert.equal(f.urls[0]!.dynamic, false);
  });

  test("a template that merely starts with an identifier is not a URL", async () => {
    // `${event} - ${reference}` is a log message. Accepting it would give the
    // linker a destination named `event`.
    const f = await scan("a.js", "const subject = `${event} - ${reference}`;");
    assert.deepEqual(f.urls, []);
  });

  test("an absolute literal URL needs no base var", async () => {
    const f = await scan("a.js", "const u = 'https://api.stripe.com/v1/charges';");
    assert.equal(f.urls[0]?.baseVar, null);
    assert.equal(f.urls[0]?.literalPath, "https://api.stripe.com/v1/charges");
  });
});

describe("env bindings", () => {
  test("captures the env var AND the default, including an empty one", async () => {
    // PROCUREMENT_BASE_URL defaults to '' on this corpus. That empty default
    // is exactly why its branch is conditional rather than dead, so dropping
    // it would lose the reason the two-candidate case exists.
    const f = await scan("server.js", [
      "const ENGINE_BASE_URL = process.env.ENGINE_BASE_URL || 'http://localhost:3002';",
      "const PROCUREMENT_BASE_URL = process.env.PROCUREMENT_BASE_URL || '';",
    ].join("\n"));
    const byName = new Map(f.envBindings.map((b) => [b.name, b]));
    assert.equal(byName.get("ENGINE_BASE_URL")?.defaultUrl, "http://localhost:3002");
    assert.equal(byName.get("ENGINE_BASE_URL")?.urlShaped, true);
    assert.equal(byName.get("PROCUREMENT_BASE_URL")?.defaultUrl, "");
    assert.equal(byName.get("PROCUREMENT_BASE_URL")?.urlShaped, false);
  });

  test("a non-URL env binding is kept, because which vars are base URLs is declared", async () => {
    // repos.json carries baseUrlEnvVars. Inferring it from the default string
    // would reclassify a token as a destination the day someone gave it a
    // URL-ish default.
    const f = await scan("a.js", "const SERVICE_TOKEN = process.env.SERVICE_TOKEN || 'abc';");
    assert.equal(f.envBindings.length, 1);
    assert.equal(f.envBindings[0]!.urlShaped, false);
  });

  test("a binding with no env var is not a binding", async () => {
    const f = await scan("a.js", "const auth = req.headers.authorization || '';");
    assert.deepEqual(f.envBindings, []);
  });
});

describe("throws", () => {
  test("captures the constructor name in both languages", async () => {
    const js = await scan("a.js", "function f(){ throw new ValidationError('bad'); }");
    assert.equal(js.throws[0]?.errorName, "ValidationError");
    const py = await scan("a.py", "def f():\n    raise HTTPException(status_code=400)");
    assert.equal(py.throws[0]?.errorName, "HTTPException");
  });

  test("a bare rethrow is recorded with a null name, not skipped", async () => {
    const f = await scan("a.js", "try { g(); } catch (e) { throw e; }");
    assert.equal(f.throws.length, 1);
    assert.equal(f.throws[0]!.errorName, null);
  });

  test("the corpus idiom returns an error envelope and throws nothing", async () => {
    // Doc §Q.2 concedes THROWS is weak; here it is empty. This is the
    // measurement that justifies P1-T17 rather than a bug to fix.
    const f = await scan("server.js", [
      "function checkUserAuth(req, reply) {",
      "  if (!req.headers.authorization) {",
      "    const body = envelopeError({ code: 'KRI40-AUTH-001' });",
      "    return reply.status(401).send(body);",
      "  }",
      "  return null;",
      "}",
    ].join("\n"));
    assert.deepEqual(f.throws, [], "no throw statement exists to find");
  });
});

describe("function ranges", () => {
  test("names an arrow bound to a const, and finds the innermost at a line", async () => {
    const f = await scan("a.js", [
      "function outer() {",          // 1
      "  const inner = () => {",     // 2
      "    g();",                    // 3
      "  };",                        // 4
      "  return inner;",             // 5
      "}",                           // 6
    ].join("\n"));
    assert.ok(f.functions.some((fn) => fn.name === "outer"));
    assert.ok(f.functions.some((fn) => fn.name === "inner" && fn.form === "arrow"));
    assert.equal(enclosingFunction(f.functions, 3)?.name, "inner");
    assert.equal(enclosingFunction(f.functions, 5)?.name, "outer");
    assert.equal(enclosingFunction(f.functions, 99), null);
  });
});

describe("parser", () => {
  test("an unsupported extension returns null rather than throwing", async () => {
    // A repo containing a .md or a .sql is not an error, and a pass that
    // aborts on the first one indexes nothing.
    assert.equal(await parseFile("README.md", "# hi"), null);
  });

  test("a file with a syntax error still yields findings, and says it had errors", async () => {
    const f = await scan("a.js", "const X = process.env.PORT; function ( { ");
    assert.ok(f.parseErrors > 0, "the error is reported");
    assert.deepEqual(f.configs.map((c) => c.varName), ["PORT"], "and the good half is kept");
  });
});
