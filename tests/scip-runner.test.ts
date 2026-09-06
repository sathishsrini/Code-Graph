// Indexing exactly the declared file set (task P0-T3, OPEN-1).
//
// These guard a measured near-miss, not a hypothetical. `40-kri-router` has a
// `tsconfig.json` of `{}`, so an indexer run without a generated config picks
// up every `.ts` under the root — the dead `src/` scaffold — and skips
// `server.js`, which is the only code that runs. The result is a clean,
// confident, entirely fictional call graph (docs/measurements.md M7).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { matchGlob, documentAllowed, buildTsconfig } from "../src/static/scip/runner.ts";
import type { RepoConfig } from "../src/config/repos.ts";

function repo(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    name: "r", rootPath: "D:/r", serviceName: "r", lang: "js", framework: "fastify",
    entrypoint: "server.js", include: [], exclude: [],
    baseUrlEnvVars: [], port: null, tsconfig: null, pythonBin: null,
    ...overrides,
  } as RepoConfig;
}

describe("matchGlob", () => {
  const yes: Array<[string, string]> = [
    ["server.js", "server.js"],
    ["src/**", "src/index.ts"],
    ["src/**", "src/a/b/c.ts"],
    ["src/**", "src/a"],
    ["**/*.test.ts", "tests/a.test.ts"],
    ["**/*.test.ts", "a.test.ts"],
    ["*.log", "router.log"],
    ["node_modules/**", "node_modules/fastify/index.js"],
    ["src/*.ts", "src/a.ts"],
  ];
  for (const [pattern, path] of yes) {
    test(`${pattern} matches ${path}`, () => assert.equal(matchGlob(pattern, path), true));
  }

  const no: Array<[string, string]> = [
    ["server.js", "src/server.js"],
    ["src/*.ts", "src/a/b.ts"],
    ["*.log", "logs/a.log"],
    ["src/**", "server.js"],
    ["server.js", "server.json"],
  ];
  for (const [pattern, path] of no) {
    test(`${pattern} does not match ${path}`, () =>
      assert.equal(matchGlob(pattern, path), false));
  }

  test("a dot is literal, not a wildcard", () => {
    assert.equal(matchGlob("a.js", "axjs"), false);
  });
});

describe("documentAllowed", () => {
  // The exact 40-kri-router configuration.
  const router = repo({
    include: ["server.js"],
    exclude: ["src/**", "node_modules/**", "*.log", ".env*"],
  });

  test("the live entrypoint is indexed", () => {
    assert.equal(documentAllowed(router, "server.js"), true);
  });

  test("the dead scaffold is not", () => {
    // The whole reason this module exists.
    assert.equal(documentAllowed(router, "src/index.ts"), false);
    assert.equal(documentAllowed(router, "src/middleware/auth.ts"), false);
    assert.equal(documentAllowed(router, "src/server.ts"), false);
  });

  test("a file matching neither include nor exclude is out when include is set", () => {
    assert.equal(documentAllowed(router, "scripts/seed.js"), false);
  });

  test("an empty include means everything not excluded", () => {
    const r = repo({ include: [], exclude: ["node_modules/**"] });
    assert.equal(documentAllowed(r, "anything/at/all.ts"), true);
    assert.equal(documentAllowed(r, "node_modules/x/y.js"), false);
  });

  test("exclude beats include", () => {
    const r = repo({ include: ["src/**"], exclude: ["src/generated/**"] });
    assert.equal(documentAllowed(r, "src/a.ts"), true);
    assert.equal(documentAllowed(r, "src/generated/api.ts"), false);
  });

  test("backslash paths are normalised", () => {
    assert.equal(documentAllowed(router, "src\\index.ts"), false);
    assert.equal(documentAllowed(router, "server.js"), true);
  });
});

describe("buildTsconfig", () => {
  test("allowJs is set, without which no .js file is indexed at all", () => {
    const c = buildTsconfig(repo()) as { compilerOptions: { allowJs: boolean } };
    assert.equal(c.compilerOptions.allowJs, true);
  });

  test("the declared include/exclude are carried into the config", () => {
    const c = buildTsconfig(repo({ include: ["server.js"], exclude: ["src/**"] })) as
      { include: string[]; exclude: string[] };
    assert.deepEqual(c.include, ["server.js"]);
    assert.deepEqual(c.exclude, ["src/**/*"]);
  });

  test("a trailing /** is rewritten, because tsc rejects it outright", () => {
    // error TS5010: File specification cannot end in a recursive directory
    // wildcard ('**'). And on a rejected include list tsc indexes NOTHING —
    // which is the OPEN-1 failure from the other direction: the file set is
    // declared and the tool silently uses a different one. `60-kri-next` is
    // the only repo whose includes are directories, so this only ever
    // appeared there.
    const c = buildTsconfig(repo({ include: ["app/**", "lib/**"], exclude: [".next/**"] })) as
      { include: string[]; exclude: string[] };
    assert.deepEqual(c.include, ["app/**/*", "lib/**/*"]);
    assert.deepEqual(c.exclude, [".next/**/*"]);
  });

  test("globs tsc already accepts are left alone", () => {
    const c = buildTsconfig(repo({ include: ["src/**/*.ts", "server.js"], exclude: ["*.log"] })) as
      { include: string[]; exclude: string[] };
    assert.deepEqual(c.include, ["src/**/*.ts", "server.js"]);
    assert.deepEqual(c.exclude, ["*.log"]);
  });

  test("an empty include widens to everything rather than indexing nothing", () => {
    const c = buildTsconfig(repo()) as { include: string[] };
    assert.deepEqual(c.include, ["**/*"]);
  });
});
