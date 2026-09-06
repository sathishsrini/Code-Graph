// Tests for the FastAPI boot channel (task P1-T4, R22).
//
// The reader is tested against a fixture rather than a live boot, so the suite
// stays hermetic — it must pass on a machine with no Python. The fixture is
// hand-built to carry what the corpus does NOT: a `Depends()` chain, a nested
// sub-dependency, a security dependency and a lambda. `51-integration` has
// zero `Depends` and validates its bearer token inline, so without a fixture
// the dependency-recursion half of R22 would ship unexercised.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  readFastapiDump, toBootDump, toBootRoute, securityDependencies,
} from "../src/boot/fastapi.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "fastapi-dump.json");
const dump = readFastapiDump(FIXTURE);

describe("reading the artifact", () => {
  test("rejects a foreign schema rather than half-reading it", () => {
    assert.throws(
      () => readFastapiDump(join(import.meta.dirname, "fixtures", "fastify-app.cjs")),
      /unexpected boot dump schema|Unexpected token|not valid JSON/,
    );
  });

  test("carries the framework versions that produced it", () => {
    assert.equal(dump.tool.fastapi, "0.141.1");
    assert.equal(dump.tool.starlette, "0.42.0");
  });

  test("config records key names and set-ness, never values (R23)", () => {
    const keys = Object.keys(dump.config[0]!).sort();
    assert.deepEqual(keys, ["isSet", "name"], "there is nowhere to put a value");
  });

  test("routes the framework serves but no handler declares are counted", () => {
    // /openapi.json, /docs, /docs/oauth2-redirect and /redoc. "2 routes,
    // 4 non-API routes skipped" is a different statement from "2 routes".
    assert.equal(dump.stats.nonApiRoutes, 4);
  });
});

describe("narrowing onto the shared BootDump", () => {
  const boot = toBootDump(dump);

  test("both frameworks land on one downstream shape", () => {
    assert.equal(boot.service, "fixture-api");
    assert.equal(boot.evidenceKind, "boot");
    assert.equal(boot.confidence, "certain");
    assert.equal(boot.routes.length, 2);
  });

  test("chain order is preserved exactly as boot reported it", () => {
    const po = boot.routes.find((r) => r.url === "/api/v1/po")!;
    assert.deepEqual(
      po.chain.map((c) => `${c.position}:${c.name ?? "(anon)"}`),
      [
        "0:correlation_middleware",
        "1:CORSMiddleware",
        "2:get_db",
        "3:get_current_user",
        "4:(anon)",
        "5:create_po",
      ],
    );
  });

  test("a sub-dependency runs before the dependency that requires it", () => {
    // FastAPI resolves `Depends(get_current_user)` nesting `Depends(get_db)`
    // inner-first, so a post-order walk IS the execution order. Emitting them
    // in declaration order would invert an ordering the reader relies on.
    const po = dump.routes.find((r) => r.url === "/api/v1/po")!;
    const db = po.chain.find((c) => c.name === "get_db")!;
    const user = po.chain.find((c) => c.name === "get_current_user")!;
    assert.ok(db.position < user.position);
    assert.equal(db.depth, 1, "the sub-dependency records its nesting");
    assert.equal(user.depth, 0);
  });

  test("middleware and dependencies both map to preHandler", () => {
    // They differ in Python and the difference is real, but "when does it run
    // relative to the handler" is the question every downstream query asks.
    // The distinction survives in `origin`, not in a phase name no other
    // framework has.
    const health = toBootRoute(dump.routes[0]!, "fixture-api");
    assert.deepEqual(health.chain.map((c) => c.phase),
      ["preHandler", "preHandler", "handler"]);
  });

  test("app-wide middleware is marked inherited from the app", () => {
    // Starlette middleware wraps the router, so every route carries it. A null
    // `inheritedFrom` would read as "declared on this route", which is false.
    const health = toBootRoute(dump.routes[0]!, "fixture-api");
    assert.equal(health.chain[0]!.inheritedFrom, "fixture-api");
    assert.equal(health.chain[2]!.inheritedFrom, null, "the handler is the route's own");
  });

  test("framework code keeps its origin, so a SCIP join is not expected to find it", () => {
    const health = toBootRoute(dump.routes[0]!, "fixture-api");
    assert.equal(health.chain[1]!.origin, "framework");
    assert.equal(health.chain[0]!.origin, "scope");
  });

  test("an anonymous dependency is located, not dropped (delta D3)", () => {
    const po = toBootRoute(dump.routes[1]!, "fixture-api");
    const anon = po.chain.find((c) => c.name === null)!;
    assert.equal(anon.anonymous, true);
    assert.equal(anon.key, "main.py:52:0", "position is the identity, not the name");
    assert.equal(dump.stats.unlocatedChainEntries, 0);
  });
});

describe("security dependencies", () => {
  test("reports the ones FastAPI itself classified", () => {
    assert.deepEqual(
      securityDependencies(dump).map((s) => s.name),
      ["get_current_user"],
    );
  });

  test("an empty result means no security dependency, never no auth", () => {
    // 51-integration compares a bearer token with a plain header read inside
    // the handler. It returns zero here and is still authenticated — the same
    // shape as POST /api/v1/po on the router (measurements M6), and the reason
    // R26's inline detector is on the critical path.
    const noDeps = {
      ...dump,
      routes: dump.routes.map((r) => ({
        ...r, chain: r.chain.map((c) => ({ ...c, security: false })),
      })),
    };
    assert.deepEqual(securityDependencies(noDeps), []);
  });
});

describe("OPEN-6 — schemas are unavailable on this corpus", () => {
  test("the artifact says so rather than leaving an unexplained column of nulls", () => {
    assert.ok(
      dump.warnings.some((w) => w.includes("no component schemas")),
      "the gap is stated in the artifact, not discovered later",
    );
    assert.deepEqual((dump.openapi as { components: { schemas: object } }).components.schemas, {});
  });
});
