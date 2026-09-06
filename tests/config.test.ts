// Tests for the repo configuration loader (task P0-T2).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateConfig, loadConfig, repoByName, ConfigError } from "../src/config/repos.ts";

const NO_PATH_CHECK = { checkPaths: false };

function minimal(overrides: Record<string, unknown> = {}): unknown {
  return {
    repos: [
      {
        name: "svc",
        rootPath: process.platform === "win32" ? "C:/tmp/svc" : "/tmp/svc",
        lang: "ts",
        framework: "fastify",
        ...overrides,
      },
    ],
  };
}

describe("validateConfig", () => {
  test("accepts a minimal repo and applies defaults", () => {
    const config = validateConfig(minimal(), NO_PATH_CHECK);
    const repo = config.repos[0]!;

    assert.equal(repo.name, "svc");
    assert.equal(repo.serviceName, "svc", "serviceName defaults to name");
    assert.deepEqual(repo.include, []);
    assert.deepEqual(repo.exclude, []);
    assert.deepEqual(repo.baseUrlEnvVars, []);
    assert.equal(repo.entrypoint, "");
    assert.equal(repo.port, null);
    assert.equal(repo.tsconfig, null);
  });

  test("keeps an explicit serviceName distinct from the repo name", () => {
    const config = validateConfig(minimal({ serviceName: "router" }), NO_PATH_CHECK);
    assert.equal(config.repos[0]!.serviceName, "router");
  });

  test("rejects an unknown lang and names the exact path", () => {
    assert.throws(
      () => validateConfig(minimal({ lang: "rust" }), NO_PATH_CHECK),
      (e: unknown) => {
        assert.ok(e instanceof ConfigError);
        assert.match(e.message, /repos\[0\]\.lang/);
        assert.match(e.message, /ts \| js \| py/);
        return true;
      },
    );
  });

  test("rejects an unknown framework", () => {
    assert.throws(
      () => validateConfig(minimal({ framework: "express" }), NO_PATH_CHECK),
      /repos\[0\]\.framework/,
    );
  });

  test("rejects a relative rootPath", () => {
    assert.throws(
      () => validateConfig(minimal({ rootPath: "./svc" }), NO_PATH_CHECK),
      /rootPath must be absolute/,
    );
  });

  test("rejects duplicate repo names", () => {
    const raw = {
      repos: [
        { name: "dup", rootPath: "/tmp/a", lang: "ts", framework: "none" },
        { name: "dup", rootPath: "/tmp/b", lang: "ts", framework: "none" },
      ],
    };
    assert.throws(() => validateConfig(raw, NO_PATH_CHECK), /duplicate repo name "dup"/);
  });

  test("rejects an empty repo list", () => {
    assert.throws(() => validateConfig({ repos: [] }, NO_PATH_CHECK), /at least one repo/);
  });

  test("rejects a missing repos key", () => {
    assert.throws(() => validateConfig({}, NO_PATH_CHECK), /repos: expected an array/);
  });

  test("rejects a non-string entry inside include", () => {
    assert.throws(
      () => validateConfig(minimal({ include: ["ok", 42] }), NO_PATH_CHECK),
      /repos\[0\]\.include\[1\]: expected a string/,
    );
  });

  test("reports a missing rootPath when path checking is on", () => {
    const missing = process.platform === "win32"
      ? "C:/definitely/not/here/xyzzy"
      : "/definitely/not/here/xyzzy";
    assert.throws(
      () => validateConfig(minimal({ rootPath: missing }), { checkPaths: true }),
      /rootPath does not exist/,
    );
  });
});

describe("loadConfig", () => {
  test("reports a missing file clearly", () => {
    assert.throws(() => loadConfig("does/not/exist.json"), /config file not found/);
  });

  test("the shipped config/repos.json is structurally valid", () => {
    // checkPaths is off: CI does not have the D: corpus mounted.
    const config = loadConfig("config/repos.json", NO_PATH_CHECK);
    assert.equal(config.repos.length, 4);

    const names = config.repos.map((r) => r.name).sort();
    assert.deepEqual(names, ["40-kri-router", "41-kri-engine", "51-integration", "60-kri-next"]);
  });

  test("OPEN-1: the two Fastify fixtures exclude their dead src/ trees", () => {
    const config = loadConfig("config/repos.json", NO_PATH_CHECK);

    for (const name of ["40-kri-router", "41-kri-engine"]) {
      const repo = repoByName(config, name);
      assert.ok(repo, `${name} present`);
      assert.ok(
        repo.exclude.includes("src/**"),
        `${name} must exclude src/** — it is non-compiling scaffolding that never runs`,
      );
      assert.deepEqual(
        repo.include, repo.include.filter((g) => !g.startsWith("src/")),
        `${name} must not include anything under src/`,
      );
      assert.equal(repo.entrypoint, "server.js");
    }
  });

  test("60-kri-next excludes generated .next types", () => {
    const config = loadConfig("config/repos.json", NO_PATH_CHECK);
    const next = repoByName(config, "60-kri-next");
    assert.ok(next);
    assert.ok(next.exclude.includes(".next/**"));
    assert.equal(next.tsconfig, "tsconfig.json");
  });

  test("every repo declaring a port declares a unique one", () => {
    const config = loadConfig("config/repos.json", NO_PATH_CHECK);
    const ports = config.repos.map((r) => r.port).filter((p): p is number => p !== null);
    assert.equal(new Set(ports).size, ports.length, "ports must be unique");
  });

  test("config file parses as JSON with no trailing-comma damage", () => {
    const text = readFileSync(resolve("config/repos.json"), "utf8");
    assert.doesNotThrow(() => JSON.parse(text));
  });
});
