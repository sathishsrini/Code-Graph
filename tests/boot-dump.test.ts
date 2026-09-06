// Fastify boot-time reflection (task P0-T8).
//
// Runs the adapter as a child process against tests/fixtures/fastify-app.cjs.
// The adapter boots a foreign app in-process, so isolating it is the point:
// a fixture that crashed or hung would otherwise take the test runner with it.
//
// Two assertions here exist because the first two implementations were wrong,
// and both were wrong in the SILENT direction — they produced a well-formed
// dump that under-reported the chain (docs/measurements.md M6):
//
//   "the chain is more than the handler"  guards reading hooks from
//                                          routeOptions, which carries only
//                                          route-level hooks
//   "inherits the root hooks"              guards reading instance[kHooks]
//                                          during onRoute, before avvio has
//                                          populated it

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const adapter = resolve(root, "adapters/fastify/boot-dump.cjs");
const fixture = resolve(root, "tests/fixtures/fastify-app.cjs");

interface ChainEntry {
  position: number;
  phase: string;
  name: string | null;
  key: string;
  file: string | null;
  line: number | null;
  col: number | null;
  anonymous: boolean;
  origin: string;
  declaredIn: string | null;
  inheritedFrom: string | null;
}
interface Route {
  method: string;
  url: string;
  routeKey: string;
  chain: ChainEntry[];
}
interface Dump {
  schema: string;
  evidenceKind: string;
  confidence: string;
  stats: {
    routes: number;
    chainEntries: number;
    anonymousChainEntries: number;
    unlocatedChainEntries: number;
  };
  routes: Route[];
  warnings: string[];
}

function runAdapter(extra: string[] = []): Dump {
  const r = spawnSync(
    process.execPath,
    [adapter, "--entry", fixture, "--service", "fixture", "--cwd", root, ...extra],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(r.status, 0, `adapter exited ${r.status}\n${r.stderr}`);
  return JSON.parse(r.stdout) as Dump;
}

let dump: Dump;
let fixtureLines: string[];

before(() => {
  dump = runAdapter();
  fixtureLines = readFileSync(fixture, "utf8").split("\n");
});

const routeOf = (method: string, url: string): Route => {
  const r = dump.routes.find((x) => x.method === method && x.url === url);
  assert.ok(r, `no route ${method} ${url}; have: ` +
    dump.routes.map((x) => `${x.method} ${x.url}`).join(", "));
  return r;
};
const phases = (r: Route) => r.chain.map((c) => c.phase);

describe("boot dump — shape", () => {
  test("declares its provenance so a row can carry it (R8, R25)", () => {
    assert.equal(dump.schema, "codeintel.boot.fastify/1");
    assert.equal(dump.evidenceKind, "boot");
    assert.equal(dump.confidence, "certain");
  });

  test("reports the routes Fastify actually has, auto-HEAD included", () => {
    const keys = dump.routes.map((r) => `${r.method} ${r.url}`).sort();
    assert.deepEqual(keys, [
      "GET /billing/invoice",
      "GET /health",
      "HEAD /billing/invoice",
      "HEAD /health",
      "POST /guarded",
    ]);
  });

  test("the auto-generated HEAD route appears in no source file", () => {
    // Boot reflection's payoff in one assertion: Fastify synthesises a HEAD
    // route per GET, and a static reader of the source would never see it.
    const src = fixtureLines.join("\n");
    assert.equal(src.includes(".head("), false, "fixture declares no HEAD route");
    assert.ok(dump.routes.some((r) => r.method === "HEAD"));
  });
});

describe("boot dump — ordered chain (R21)", () => {
  test("the chain is more than the handler", () => {
    // routeOptions in an onRoute hook carries ONLY route-level hooks. Reading
    // the chain from it yields exactly one entry per route, which reads as
    // "this route has no middleware" — a false negative, not an error.
    for (const r of dump.routes) {
      assert.ok(
        r.chain.length > 1,
        `${r.method} ${r.url} has a handler-only chain: ${JSON.stringify(phases(r))}`,
      );
    }
  });

  test("a root route runs onRequest, then the handler, then onResponse", () => {
    assert.deepEqual(phases(routeOf("GET", "/health")),
      ["onRequest", "handler", "onResponse"]);
  });

  test("positions are dense and ascending from zero", () => {
    for (const r of dump.routes) {
      assert.deepEqual(r.chain.map((c) => c.position), r.chain.map((_, i) => i));
    }
  });

  test("a route-level hook lands between onRequest and the handler", () => {
    const chain = routeOf("POST", "/guarded").chain;
    assert.deepEqual(phases(routeOf("POST", "/guarded")),
      ["onRequest", "preHandler", "handler", "onResponse"]);
    const guard = chain[1]!;
    assert.equal(guard.name, "routeGuard");
    assert.equal(guard.origin, "route", "declared in the route options, not the scope");
  });

  test("Fastify's own injected hooks are marked framework, not service code", () => {
    const onSend = routeOf("HEAD", "/health").chain.find((c) => c.phase === "onSend");
    assert.ok(onSend, "auto HEAD route carries Fastify's onSend hook");
    assert.equal(onSend.origin, "framework");
    assert.match(onSend.file ?? "", /node_modules/);
  });
});

describe("boot dump — encapsulation (R6 inherited_from)", () => {
  const invoice = () => routeOf("GET", "/billing/invoice");

  test("a plugin route inherits the root hooks", () => {
    // instance[kHooks] is empty while onRoute fires for a ROOT route, because
    // addHook on the root is deferred through avvio. Reading it then makes
    // inherited hooks vanish from every plugin route.
    assert.deepEqual(phases(invoice()),
      ["onRequest", "preHandler", "handler", "onResponse"]);
    const onRequest = invoice().chain[0]!;
    assert.equal(onRequest.inheritedFrom, "root");
    assert.equal(onRequest.origin, "scope");
  });

  test("the plugin's own hook is attributed to the plugin, not inherited", () => {
    const pre = invoice().chain.find((c) => c.phase === "preHandler")!;
    assert.equal(pre.name, "requireTenant");
    assert.equal(pre.declaredIn, "billingPlugin");
    assert.equal(pre.inheritedFrom, null, "declared here, so not inherited");
  });

  test("a root route's hooks are not marked inherited", () => {
    for (const c of routeOf("GET", "/health").chain) {
      assert.equal(c.inheritedFrom, null, `${c.phase} should not be inherited`);
    }
  });
});

describe("boot dump — hook identity (the P0-T8 acceptance criterion)", () => {
  test("every chain entry resolves to a source location", () => {
    assert.equal(dump.stats.unlocatedChainEntries, 0);
    for (const r of dump.routes) {
      for (const c of r.chain) {
        assert.ok(c.file, `${r.routeKey} ${c.phase} has no file`);
        assert.ok(c.line && c.line > 0, `${r.routeKey} ${c.phase} has no line`);
      }
    }
  });

  test("anonymous hooks still get a usable key", () => {
    // The plan's fix was to rename the fixture's arrow hooks. That labels the
    // fixture, not the engine: anonymous hooks are the dominant idiom, and 63
    // of 71 chain entries in 41-kri-engine are anonymous.
    const anon = routeOf("GET", "/health").chain.filter((c) => c.anonymous);
    assert.ok(anon.length > 0, "the fixture registers anonymous hooks on purpose");
    for (const c of anon) {
      assert.equal(c.name, null);
      assert.match(c.key, /^[\w./-]+\.cjs:\d+:\d+$/, `unusable key: ${c.key}`);
    }
  });

  test("a reported line:col actually points at that function in the source", () => {
    for (const r of dump.routes) {
      for (const c of r.chain) {
        if (!c.file || !c.file.endsWith("fastify-app.cjs")) continue;
        const text = fixtureLines[c.line! - 1] ?? "";
        const at = text.slice(c.col!);
        assert.match(
          at,
          /^(async\s+)?(function\b|\()/,
          `${r.routeKey} ${c.phase} -> ${c.key} points at ${JSON.stringify(at.slice(0, 40))}`,
        );
        // For a named function expression V8 reports the column of the
        // PARAMETER LIST, so the name sits before it — check the whole line.
        if (c.name) {
          assert.ok(text.includes(c.name), `${c.key} should name ${c.name}`);
        }
      }
    }
  });
});

describe("boot dump — honesty and determinism", () => {
  test("the default run is clean and carries no plugin tree", () => {
    // R21 named fastify-overview; it is opt-in here for three measured
    // reasons (docs/measurements.md M6), non-determinism among them.
    assert.deepEqual(dump.warnings, []);
  });

  test("--overview under-reports module-scope routes, and says so", () => {
    // It instruments during ready(), so routes registered at module scope are
    // invisible to it. A partial tree is worse than none — it looks credible —
    // so any under-report must surface as a warning rather than pass silently.
    const withOverview = runAdapter(["--overview"]);
    assert.ok(
      withOverview.warnings.some((w) => w.includes("fastify-overview")),
      `expected an under-report warning, got: ${JSON.stringify(withOverview.warnings)}`,
    );
    // The chain must be identical either way — it never came from the plugin.
    assert.deepEqual(
      withOverview.routes.map((r) => r.chain.map((c) => c.key)),
      dump.routes.map((r) => r.chain.map((c) => c.key)),
    );
  });

  test("two runs agree on everything but the timestamp", () => {
    // Phase 0 acceptance criterion 3: re-running produces identical output.
    const a = runAdapter();
    const b = runAdapter();
    const strip = (d: Dump) => {
      const { ...rest } = d as Dump & { generatedAt?: string };
      delete (rest as { generatedAt?: string }).generatedAt;
      return JSON.stringify(rest);
    };
    assert.equal(strip(a), strip(b));
  });
});
