// Tests for `build` — slice CTX-S6 (plans/claude-context-plan.md §6).
//
// `index` alone yields an empty graph: it READS the `scip index` and `boot
// dump` artifacts, and producing them was a separate manual step per repo.
// `build` runs every channel for every repo. The property under test is the
// one that makes it safe to run unattended: each channel's outcome is
// reported by name, and a failed channel never takes the others with it.
//
// The fixture is a real Fastify-shaped repo whose boot throws (as a service
// does when its database is down), run through the REAL runners. PATH is
// emptied for the run, so `scip-typescript` is absent on every machine —
// including one where it is installed — and its absence must come back as a
// named channel failure, not a crash.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync, readdirSync, readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { FactStore } from "../src/store/db.ts";
import { buildGraph, renderBuildReport, type BuildReport } from "../src/index/build.ts";
import type { RepoConfig } from "../src/config/repos.ts";

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), "code-intel-build-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

function repo(name: string, root: string, framework: RepoConfig["framework"]): RepoConfig {
  return {
    name, rootPath: root, serviceName: name, lang: "js", framework,
    entrypoint: framework === "fastify" ? "server.js" : "",
    include: [], exclude: [], baseUrlEnvVars: [], port: null, tsconfig: null, pythonBin: null,
  };
}

/** A service whose module scope throws, the way one does when Postgres is down. */
function failingService(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "server.js"), [
    "const url = process.env.DATABASE_URL;",
    "function connect() {",
    "  throw new Error('connect ECONNREFUSED 127.0.0.1:5432');",
    "}",
    "connect();",
    "",
  ].join("\n"));
}

/**
 * Every path under `root` with a digest of its bytes (directories too, so an
 * empty `__pycache__/` counts). `build` must leave the repos it reads exactly
 * as it found them: the generated tsconfig removed, no bytecode written.
 */
function snapshot(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .map((e) => {
      const abs = join(e.parentPath, e.name);
      const rel = relative(root, abs).split("\\").join("/");
      return e.isFile()
        ? `${rel} ${createHash("sha256").update(readFileSync(abs)).digest("hex")}`
        : `${rel}/`;
    })
    .sort();
}

function repoId(store: FactStore, name: string): number {
  return (store.raw().prepare("SELECT id FROM repos WHERE name = ?").get(name) as { id: number }).id;
}

function channel(report: BuildReport, repoName: string, name: string) {
  const r = report.repos.find((x) => x.repo === repoName);
  assert.ok(r, `no outcome for ${repoName}`);
  const c = r.channels.find((x) => x.channel === name);
  assert.ok(c, `no ${name} outcome for ${repoName}`);
  return c;
}

describe("build over a repo whose boot fails, with no scip-typescript on PATH", () => {
  let store: FactStore;
  let report: BuildReport;
  let beforeBuild: string[];
  let afterBuild: string[];

  before(async () => {
    const root = join(dir, "svc");
    failingService(root);
    store = new FactStore(join(dir, "graph.db"));
    beforeBuild = snapshot(root);
    const path = process.env.PATH;
    process.env.PATH = join(dir, "empty-bin");   // exists nowhere: no indexer
    try {
      report = await buildGraph({
        store, repos: [repo("svc", root, "fastify")], artifactDir: join(dir, "artifacts"),
      });
    } finally {
      process.env.PATH = path;
    }
    afterBuild = snapshot(root);
  });
  after(() => { store.close(); });

  test("the target repo is left exactly as found: the generated tsconfig is removed", () => {
    // runScipTypescript writes tsconfig.codeintel.json into the repo before it
    // spawns the indexer, so a failed spawn is the case most likely to leak it.
    assert.deepEqual(afterBuild, beforeBuild);
  });

  test("the boot failure is named, with the first line of its error", () => {
    const boot = channel(report, "svc", "boot");
    assert.equal(boot.status, "failed");
    assert.match(boot.detail, /ECONNREFUSED 127\.0\.0\.1:5432/);
    assert.ok(!boot.detail.includes("\n"), "one line, not a stack trace");
  });

  test("scip-typescript's absence is a named channel failure, not a crash", () => {
    const scip = channel(report, "svc", "scip");
    assert.equal(scip.status, "failed");
    assert.match(scip.detail, /scip-typescript/);
  });

  test("the static channel is still indexed", () => {
    const index = channel(report, "svc", "index");
    assert.equal(index.status, "ok", index.detail);
    assert.ok(store.getFile(repoId(store, "svc"), "server.js"), "server.js is in the graph");
    const treesitter = store.raw().prepare(
      "SELECT COUNT(*) AS n FROM edges WHERE evidence_kind = 'treesitter'",
    ).get() as { n: number };
    assert.ok(treesitter.n > 0, "tree-sitter findings were written without scip or boot");
    // The artifacts that did not get built are named, not silently empty.
    assert.match(index.detail, /missing: scip index, boot dump/);
  });

  test("the graph-wide steps still run after the failures", () => {
    const search = report.graph.find((c) => c.channel === "search");
    assert.equal(search?.status, "ok", search?.detail);
  });

  test("the summary names every failure, and only failures", () => {
    assert.deepEqual(report.failures.map((f) => f.split(":")[0]), ["svc scip", "svc boot"]);
    const text = renderBuildReport(report);
    assert.match(text, /FAILED 2 of \d+ channels/);
    assert.ok(text.includes("svc boot: ") && text.includes("ECONNREFUSED"), text);
    assert.ok(text.includes("svc scip: ") && text.includes("scip-typescript"), text);
  });
});

describe("build: channel isolation (injected runners)", () => {
  test("a runner that throws is reported as failed, and the others still run", async () => {
    const root = join(dir, "throws");
    failingService(root);
    const store = new FactStore(join(dir, "throws.db"));
    try {
      const report = await buildGraph({
        store, repos: [repo("t", root, "none")], artifactDir: join(dir, "throws-artifacts"),
        runners: { scip: () => { throw new Error("indexer crashed\n    at somewhere (x.js:1:1)"); } },
      });
      const scip = channel(report, "t", "scip");
      assert.equal(scip.status, "failed");
      assert.equal(scip.detail, "indexer crashed");
      assert.equal(channel(report, "t", "index").status, "ok");
      assert.deepEqual(report.failures, ["t scip: indexer crashed"]);
    } finally { store.close(); }
  });

  test("a framework with no boot adapter is skipped with its reason", async () => {
    const root = join(dir, "noadapter");
    failingService(root);
    const store = new FactStore(join(dir, "noadapter.db"));
    try {
      const report = await buildGraph({
        store, repos: [repo("n", root, "nextjs")], artifactDir: join(dir, "noadapter-artifacts"),
        runners: { scip: () => ({ ok: true, error: "", detail: "stub" }) },
      });
      const boot = channel(report, "n", "boot");
      assert.equal(boot.status, "skipped");
      assert.match(boot.detail, /no adapter for framework "nextjs"/);
      assert.deepEqual(report.failures, [], "a skip is not a failure");
    } finally { store.close(); }
  });

  test("the Python boot writes no bytecode into the target repo", async (t) => {
    // The FastAPI adapter imports the entry with the repo on sys.path, so every
    // local module it pulls in would be compiled into the repo's __pycache__/.
    const root = join(dir, "pyboot");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "helpers.py"), "DSN = 'postgresql://localhost/app'\n");
    writeFileSync(join(root, "main.py"), "import helpers\nraise RuntimeError('database is down')\n");
    const before = snapshot(root);
    const store = new FactStore(join(dir, "pyboot.db"));
    try {
      const report = await buildGraph({
        store, artifactDir: join(dir, "pyboot-artifacts"),
        repos: [{ ...repo("p", root, "fastapi"), lang: "py", entrypoint: "main.py" }],
        runners: { scip: () => ({ ok: true, error: "", detail: "stub" }) },
      });
      const boot = channel(report, "p", "boot");
      if (/ENOENT/.test(boot.detail)) {
        t.skip("no `python` on PATH, so the adapter never imported anything");
        return;
      }
      assert.match(boot.detail, /database is down/, "helpers.py was imported before the failure");
      assert.deepEqual(snapshot(root), before);
    } finally { store.close(); }
  });

  test("a repo root that is not on disk fails by name and its graph is left alone", async () => {
    const root = join(dir, "moved");
    failingService(root);
    const store = new FactStore(join(dir, "moved.db"));
    const stub = { scip: () => ({ ok: true, error: "", detail: "stub" }) };
    try {
      const repos = [repo("m", root, "none")];
      await buildGraph({ store, repos, artifactDir: join(dir, "moved-a"), runners: stub });
      renameSync(root, `${root}-elsewhere`);
      const report = await buildGraph({ store, repos, artifactDir: join(dir, "moved-a"), runners: stub });

      assert.equal(channel(report, "m", "scip").status, "failed");
      assert.match(channel(report, "m", "scip").detail, /root not on disk/);
      assert.equal(channel(report, "m", "index").status, "skipped");
      // Indexing an absent root would read as "every file deleted" and purge them.
      assert.ok(store.getFile(repoId(store, "m"), "server.js"), "the indexed file was not purged");
    } finally { store.close(); }
  });
});
