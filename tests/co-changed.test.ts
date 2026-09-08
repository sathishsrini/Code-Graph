// Tests for co_changed (task P3-T1, R65).
//
// This is the one v2 association type the plan kept, and it survived because
// it is derived from EVIDENCE — two files appeared in N of the same commits,
// checkable by anyone with `git`. The tests below are mostly about the two
// ways that evidence gets swamped: merge commits and wide commits.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactStore } from "../src/store/db.ts";
import {
  countPairs, deriveCoChanged, peersOf, readHistory, type Commit,
} from "../src/derive/co-changed.ts";

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), "code-intel-cc-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

const commit = (sha: string, files: string[], date = "2026-01-01"): Commit =>
  ({ sha, date, files });

describe("counting pairs", () => {
  test("a pair is counted once per commit, in a stable order", () => {
    const { pairs } = countPairs(
      [commit("a", ["b.ts", "a.ts"]), commit("b", ["a.ts", "b.ts"])],
      new Set(["a.ts", "b.ts"]), 30,
    );
    assert.equal(pairs.size, 1, "(a,b) and (b,a) are one pair, not two");
    assert.equal([...pairs.values()][0]!.commits, 2);
  });

  test("a wide commit is skipped rather than contributing n²/2 noise", () => {
    // A 400-file reformat says nothing about coupling and would contribute
    // 79,800 pairs, drowning every real one.
    const wide = Array.from({ length: 40 }, (_, i) => `f${i}.ts`);
    const { pairs, skipped } = countPairs(
      [commit("wide", wide), commit("narrow", ["a.ts", "b.ts"])],
      new Set([...wide, "a.ts", "b.ts"]), 30,
    );
    assert.equal(skipped, 1);
    assert.equal(pairs.size, 1, "only the narrow commit's pair survives");
  });

  test("a commit touching one known file contributes nothing", () => {
    const { pairs } = countPairs(
      [commit("a", ["a.ts", "unknown.md"])], new Set(["a.ts"]), 30,
    );
    assert.equal(pairs.size, 0);
  });

  test("files the index never saw are excluded", () => {
    // Otherwise the table is mostly lockfiles and markdown, and none of it
    // joins to anything.
    const { pairs } = countPairs(
      [commit("a", ["a.ts", "b.ts", "README.md"])], new Set(["a.ts", "b.ts"]), 30,
    );
    assert.equal(pairs.size, 1);
  });

  test("per-file totals are the denominator for support", () => {
    const { perFile } = countPairs(
      [commit("1", ["a.ts", "b.ts"]), commit("2", ["a.ts", "c.ts"])],
      new Set(["a.ts", "b.ts", "c.ts"]), 30,
    );
    assert.equal(perFile.get("a.ts"), 2, "a.ts was in both");
    assert.equal(perFile.get("b.ts"), 1);
  });
});

describe("storing and querying", () => {
  function seeded(name: string): { store: FactStore; repoId: number } {
    const store = new FactStore(join(dir, name));
    const repoId = store.upsertRepo("svc", "/tmp/svc", "svc");
    const runId = store.startRun(repoId, "static", "t", "");
    for (const f of ["a.ts", "b.ts", "c.ts"]) {
      store.upsertFile(repoId, f, "ts", `h-${f}`, runId);
    }
    return { store, repoId };
  }

  test("support is directional and is the number worth reading", () => {
    // 12 shared commits means little without knowing whether that is 12 of
    // the file's 14 or 12 of its 400.
    const { store, repoId } = seeded("support.db");
    try {
      const runId = store.startRun(repoId, "static", "t", "");
      store.raw().prepare(
        `INSERT INTO co_changed
           (repo_id, file_a, file_b, commits, support_a, support_b, run_id)
         VALUES (?, 'a.ts', 'b.ts', 5, 0.25, 1.0, ?)`,
      ).run(repoId, runId);

      const fromA = peersOf(store, "a.ts");
      assert.equal(fromA[0]!.file, "b.ts");
      assert.equal(fromA[0]!.support, 0.25, "a.ts changes without b.ts often");

      const fromB = peersOf(store, "b.ts");
      assert.equal(fromB[0]!.support, 1, "b.ts never changes without a.ts");
    } finally { store.close(); }
  });

  test("a non-git target reports unavailable, not zero pairs", () => {
    // "These files never change together" is a claim about the code; "git is
    // not available here" is a claim about the tooling.
    const { store } = seeded("nogit.db");
    try {
      const report = deriveCoChanged(store, "svc", join(dir, "definitely-not-a-repo"));
      assert.ok(report.unavailable, "the reason is reported");
      assert.equal(report.pairs, 0);
    } finally { store.close(); }
  });

  test("an unindexed repo is refused with a fix, not silently skipped", () => {
    const store = new FactStore(join(dir, "unindexed.db"));
    try {
      const report = deriveCoChanged(store, "never-indexed", "/tmp/x");
      assert.match(report.unavailable ?? "", /index it first/);
    } finally { store.close(); }
  });

  test("git is read from THIS repo, and produces real pairs", () => {
    // An end-to-end check against actual history rather than a fixture: this
    // project is a git repo and its own commits are the test data.
    const { commits, unavailable } = readHistory(process.cwd(), 200);
    if (unavailable) return;   // a shallow CI checkout has no history to read
    assert.ok(commits.length > 0);
    assert.ok(commits.every((c) => c.sha.length >= 7), "a sha per commit");
    assert.ok(commits.some((c) => c.files.length > 0), "and its file list");
  });
});
