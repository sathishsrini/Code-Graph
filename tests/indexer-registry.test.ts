// Tests for the indexer registry (task P3-T5, R69).
//
// The completeness test below is the point of the whole task. The dispatch this
// replaced was
//
//     repo.lang === "py" ? runScipPython(...) : runScipTypescript(...)
//
// so every language that was not `py` silently got scip-typescript. Adding
// `lang: "go"` to a config would have generated a tsconfig, run a TypeScript
// indexer over Go source, written an index describing almost nothing, and
// reported a service with no symbols and no reason given — the confident
// fictional architecture this project exists to stop shipping, reached by one
// line in a config file.
//
// That failure is now a red test in the PR that introduces it.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { LANGS, type Lang, type RepoConfig } from "../src/config/repos.ts";
import {
  ADAPTERS, adapterFor, probe, supportedLangs,
} from "../src/static/scip/registry.ts";

const repo = (overrides: Partial<RepoConfig> = {}): RepoConfig => ({
  name: "r", rootPath: "D:/r", serviceName: "r", lang: "js", framework: "fastify",
  entrypoint: "server.js", include: [], exclude: [],
  baseUrlEnvVars: [], port: null, tsconfig: null, pythonBin: null,
  ...overrides,
} as RepoConfig);

describe("registry completeness", () => {
  test("EVERY declared language has an adapter", () => {
    // Adding a `Lang` without an adapter is the defect this task exists to
    // make impossible. If this fails, add an entry to ADAPTERS — do not relax
    // the assertion.
    for (const lang of LANGS) {
      assert.ok(
        adapterFor(lang),
        `lang "${lang}" has no indexer adapter — a repo declaring it would ` +
        "otherwise be indexed by the wrong tool or not at all",
      );
    }
  });

  test("no language has two adapters", () => {
    // Two entries for one lang means which indexer runs depends on array order.
    const seen = new Set<Lang>();
    for (const a of ADAPTERS) {
      assert.ok(!seen.has(a.lang), `duplicate adapter for ${a.lang}`);
      seen.add(a.lang);
    }
  });

  test("a language with no adapter resolves to null, never a fallback", () => {
    // The old ternary's `else` branch was the fallback. Returning null is what
    // lets the caller refuse by name instead of guessing.
    assert.equal(adapterFor("go" as Lang), null);
    assert.equal(adapterFor("" as Lang), null);
  });

  test("the supported list is non-empty and actionable", () => {
    assert.deepEqual([...supportedLangs()].sort(), ["js", "py", "ts"]);
  });

  test("every adapter carries an install hint and a file-set note", () => {
    // A refusal that does not say how to fix itself is a dead end, and the
    // file-set note is how a reader knows whether `include` was honoured by
    // the indexer or enforced later at ingest.
    for (const a of ADAPTERS) {
      assert.ok(a.install.length > 0, `${a.lang} has no install hint`);
      assert.ok(a.fileSetNote.length > 0, `${a.lang} has no file-set note`);
      assert.ok(a.name.length > 0);
    }
  });

  test("every shipped adapter is marked verified", () => {
    // `verified` means this repo has run it against a real repository and
    // ingested the result. An unverified adapter is still allowed — it is
    // labelled in the CLI output — but today all three have been run.
    for (const a of ADAPTERS) {
      assert.equal(a.verified, true, `${a.lang}/${a.name} is unverified`);
    }
  });
});

describe("availability is asked separately from success", () => {
  test("a binary that does not exist is unavailable WITH a reason", () => {
    // "The binary is missing" and "it ran and found nothing" are different
    // answers and only one of them is about the code. Conflating them turns a
    // missing toolchain into a service that looks like it has no functions.
    const missing = {
      ...ADAPTERS[0]!, name: "scip-nonexistent-indexer-xyz", lang: "ts" as Lang,
    };
    const result = probe(missing, repo());
    assert.equal(result.available, false);
    assert.equal(result.version, null);
    assert.ok(result.reason.length > 0, "an unavailable probe must say why");
  });

  test("an installed indexer reports its version", () => {
    // Pinned to scip-typescript, which is a devDependency of this repo, so the
    // probe is exercised against a real binary rather than only a missing one.
    const result = probe(adapterFor("ts")!, repo());
    assert.equal(result.available, true, result.reason);
    assert.ok((result.version ?? "").length > 0, "a version was reported");
    assert.equal(result.reason, "");
  });
});
