// Tests for the freshness line on every MCP answer — slice CTX-S6 (risk
// "Stale graph", plans/claude-context-plan.md §9).
//
// The graph is built once and then read for days while the code moves on. An
// answer about a file that changed since is a confident wrong answer unless it
// says so. These tests pin the three facts the line must carry: when the graph
// was built, which indexed files no longer match it, and which repos could not
// be checked at all — the last never reported as "every file stale".
//
// The graph is built by the real `indexRepo`, not by hand-written hashes, so a
// freshness check that hashed differently from the indexer would fail here as
// "the unchanged graph reports stale files".

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactStore } from "../src/store/db.ts";
import { indexRepo } from "../src/index/pipeline.ts";
import { checkFreshness, freshnessLine } from "../src/index/freshness.ts";
import { callTool } from "../src/mcp/server.ts";
import type { RepoConfig } from "../src/config/repos.ts";

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), "code-intel-fresh-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

function repoAt(root: string, name = "svc"): RepoConfig {
  return {
    name, rootPath: root, serviceName: name, lang: "js", framework: "none",
    entrypoint: "", include: [], exclude: [], baseUrlEnvVars: [], port: null,
    tsconfig: null, pythonBin: null,
  };
}

/** A two-file repo indexed by the real pipeline into a fresh store. */
async function indexed(label: string): Promise<{ store: FactStore; root: string }> {
  const root = join(dir, label);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "server.js"), "function handler() { return helper(); }\n");
  writeFileSync(join(root, "lib.js"), "function helper() { return 1; }\n");
  const store = new FactStore(join(dir, `${label}.db`));
  await indexRepo({ store, repo: repoAt(root), artifactDir: join(dir, `${label}-artifacts`) });
  return { store, root };
}

describe("freshness (CTX-S6)", () => {
  test("an unchanged graph reports 0 stale files", async () => {
    const { store } = await indexed("unchanged");
    try {
      const f = checkFreshness(store);
      assert.equal(f.files, 2);
      assert.deepEqual(f.stale, []);
      assert.match(f.builtAt ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      assert.match(freshnessLine(f), /0 of 2 indexed files changed since/);
    } finally { store.close(); }
  });

  test("a changed file is reported as exactly 1 stale file, by name", async () => {
    const { store, root } = await indexed("changed");
    try {
      appendFileSync(join(root, "server.js"), "// edited after the build\n");
      const f = checkFreshness(store);
      assert.deepEqual(f.stale, [{ repo: "svc", path: "server.js", state: "changed" }]);
      const line = freshnessLine(f);
      assert.match(line, /1 of 2 indexed files changed since/);
      assert.ok(line.includes("svc/server.js"), line);
      assert.ok(!line.includes("lib.js"), "the unchanged file is not named");
    } finally { store.close(); }
  });

  test("a file that disappeared is stale, and says it was deleted", async () => {
    const { store, root } = await indexed("deleted");
    try {
      rmSync(join(root, "lib.js"));
      const f = checkFreshness(store);
      assert.deepEqual(f.stale, [{ repo: "svc", path: "lib.js", state: "deleted" }]);
      assert.ok(freshnessLine(f).includes("svc/lib.js (deleted)"));
    } finally { store.close(); }
  });

  test("a repo root that is not on disk is named, not reported as every file stale", async () => {
    const { store, root } = await indexed("gone");
    try {
      rmSync(root, { recursive: true, force: true });
      const f = checkFreshness(store);
      assert.deepEqual(f.stale, []);
      assert.equal(f.unchecked.length, 1);
      const line = freshnessLine(f);
      assert.ok(line.includes("root not on disk"), line);
      assert.ok(line.includes("svc"), line);
      assert.ok(!/[1-9]\d* of \d+ indexed files changed/.test(line), line);
    } finally { store.close(); }
  });

  test("a store nothing was ever built into says so", () => {
    const store = new FactStore(join(dir, "empty.db"));
    try {
      const line = freshnessLine(checkFreshness(store));
      assert.match(line, /no build recorded/);
    } finally { store.close(); }
  });
});

describe("every MCP answer carries exactly one freshness line", () => {
  test("endpoint_flow after an edit names the edited file", async () => {
    const { store, root } = await indexed("mcp");
    try {
      appendFileSync(join(root, "server.js"), "// edited\n");
      const out = callTool(store, "endpoint_flow", { service: "svc", method: "GET", path: "/x" });
      const lines = out.trimEnd().split("\n").filter((l) => l.startsWith("freshness:"));
      assert.equal(lines.length, 1, out);
      assert.ok(lines[0]!.includes("1 of 2") && lines[0]!.includes("svc/server.js"), lines[0]);
    } finally { store.close(); }
  });

  test("it is added centrally: every tool, and even an unknown one, carries it", async () => {
    const { store } = await indexed("central");
    try {
      for (const [name, args] of [
        ["endpoint_flow", { service: "svc", method: "GET", path: "/x" }],
        ["impact", { symbol: "helper" }],
        ["security_path", {}],
        ["context_pack", { symbol: "helper", includeSource: false }],
        ["not_a_tool", {}],
      ] as const) {
        const out = callTool(store, name, { ...args });
        const n = out.split("\n").filter((l) => l.startsWith("freshness:")).length;
        assert.equal(n, 1, `${name}: ${out.slice(-200)}`);
        assert.ok(out.includes("0 of 2 indexed files changed since"), name);
      }
    } finally { store.close(); }
  });
});
