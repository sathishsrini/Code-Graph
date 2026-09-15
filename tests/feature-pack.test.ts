// Tests for the multi-seed feature pack (task P3-T9, R82).
//
// Two of these are regressions for defects the corpus found rather than the
// fixtures: a merge key without `detail` collapsed a datastore's READ and its
// WRITE into one row — so a pack for "GRN creation" reported that it *reads*
// `goods_receipts` and never said it writes it — and a symbol reached by
// expanding a route contributed the security chain of every OTHER route that
// shared it, putting fifteen routes' checks into a one-route feature.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactStore } from "../src/store/db.ts";
import {
  featurePack, featurePackToToon, FEATURE_TIERS, type FeatureTier,
} from "../src/query/feature-pack.ts";
import type { FeatureManifest } from "../src/config/features.ts";

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), "code-intel-fpack-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

const SYM = (svc: string, n: string) => `scip npm ${svc} 1 \`server.js\`/${n}().`;

interface Ctx {
  store: FactStore; repoId: number; runId: number; fileId: number;
  node: (kind: Parameters<FactStore["upsertNode"]>[0], key: string) => number;
  sym: (name: string, kind?: string) => number;
  route: (method: string, url: string) => number;
  edge: (src: number, dst: number, type: string, conf?: "certain" | "inferred") => void;
  chain: (route: number, sym: number | null, opts?: { name?: string; checkKind?: string; position?: number }) => void;
}

function ctx(store: FactStore, svc = "svc"): Ctx {
  const repoId = store.upsertRepo(svc, `/tmp/${svc}`, svc);
  const runId = store.startRun(repoId, "static", "t@0", "");
  const fileId = store.upsertFile(repoId, "server.js", "js", `h-${svc}`, runId);
  const node = (kind: Parameters<FactStore["upsertNode"]>[0], key: string) =>
    store.upsertNode(kind, key, repoId);
  const sym = (name: string, kind = "method") => {
    const id = node("symbol", SYM(svc, name));
    store.upsertSymbol({
      nodeId: id, fileId, displayName: name, symbolKind: kind,
      signature: `function ${name}()`, startLine: 10, endLine: 20,
    });
    return id;
  };
  const route = (method: string, url: string) => {
    const id = node("route", `${svc} ${method} ${url}`);
    store.upsertRoute({
      nodeId: id, repoId, serviceName: svc, method, url, source: "boot", runId,
    });
    return id;
  };
  const edge = (src: number, dst: number, type: string, conf: "certain" | "inferred" = "certain") => {
    store.insertEdge({
      srcNodeId: src, dstNodeId: dst, type: type as Parameters<FactStore["insertEdge"]>[0]["type"],
      confidence: conf, evidenceKind: "scip", fileId, line: 11, runId,
    });
  };
  const chain: Ctx["chain"] = (routeNode, symNode, opts = {}) => {
    store.insertChainEntry({
      routeNodeId: routeNode, position: opts.position ?? 0, phase: "handler",
      origin: "route", symbolNodeId: symNode ?? undefined,
      name: opts.name ?? "handler", checkKind: opts.checkKind,
      confidence: "inferred", evidenceKind: "treesitter",
      key: "server.js:10:0", fileId, line: 10, runId,
    });
  };
  return { store, repoId, runId, fileId, node, sym, route, edge, chain };
}

/** A manifest built in memory — no file, no parser, just the entry list. */
const manifestOf = (specs: string[]): FeatureManifest => ({
  path: "(test)", present: true,
  features: [{
    id: "f", name: "The Feature", aliases: [], notes: null, line: 1,
    entries: specs.map((spec, i) => ({
      kind: spec.includes(" ") && !spec.startsWith("scip") ? "route" as const : "symbol" as const,
      spec, line: i + 2,
    })),
  }],
});

describe("merging across seeds", () => {
  test("an item two seeds reach appears once, naming both", () => {
    const store = new FactStore(join(dir, "merge.db"));
    try {
      const c = ctx(store);
      const a = c.sym("alpha"), b = c.sym("beta"), shared = c.sym("shared");
      c.edge(a, shared, "CALLS");
      c.edge(b, shared, "CALLS");

      const pack = featurePack(store, "f", {
        manifest: manifestOf([SYM("svc", "alpha"), SYM("svc", "beta")]),
      });
      const rows = pack.items.filter((i) => i.tier === "callees" && i.name === "shared");
      assert.equal(rows.length, 1, "merged, not duplicated");
      assert.deepEqual([...rows[0]!.via].sort(), ["alpha", "beta"]);
    } finally { store.close(); }
  });

  test("a READ and a WRITE of the same table stay two rows", () => {
    // The regression. Without `detail` in the merge key these collapse, and a
    // pack for a feature that writes a table says only that it reads it.
    const store = new FactStore(join(dir, "rw.db"));
    try {
      const c = ctx(store);
      const seed = c.sym("createGrn");
      const table = c.node("datastore", "postgres://?/goods_receipts");
      c.edge(seed, table, "READS");
      c.edge(seed, table, "WRITES");

      const pack = featurePack(store, "f", { manifest: manifestOf([SYM("svc", "createGrn")]) });
      const details = pack.items
        .filter((i) => i.tier === "datastores" && i.name.includes("goods_receipts"))
        .map((i) => i.detail).sort();
      assert.deepEqual(details, ["READS", "WRITES"]);
    } finally { store.close(); }
  });

  test("the most-shared items sort first, so a cut keeps the spine", () => {
    const store = new FactStore(join(dir, "sort.db"));
    try {
      const c = ctx(store);
      const a = c.sym("alpha"), b = c.sym("beta");
      const shared = c.sym("zzShared"), lonely = c.sym("aaLonely");
      c.edge(a, shared, "CALLS"); c.edge(b, shared, "CALLS");
      c.edge(a, lonely, "CALLS");

      const pack = featurePack(store, "f", {
        manifest: manifestOf([SYM("svc", "alpha"), SYM("svc", "beta")]),
      });
      const callees = pack.items.filter((i) => i.tier === "callees");
      // Alphabetically `aaLonely` would win; reach count must outrank name.
      assert.equal(callees[0]!.name, "zzShared");
    } finally { store.close(); }
  });
});

describe("route seeds", () => {
  test("a route expands into its non-namespace chain symbols", () => {
    const store = new FactStore(join(dir, "expand.db"));
    try {
      const c = ctx(store);
      const handler = c.sym("realHandler");
      const callee = c.sym("deeper");
      c.edge(handler, callee, "CALLS");
      const r = c.route("POST", "/grn");
      c.chain(r, handler, { name: "realHandler" });

      const pack = featurePack(store, "f", { manifest: manifestOf(["svc POST /grn"]) });
      assert.ok(
        pack.seeds.some((s) => s.seed.display === "realHandler" && s.derivedFrom === "svc POST /grn"),
        "the handler became a seed, and says which route it came from",
      );
      assert.ok(
        pack.items.some((i) => i.tier === "callees" && i.name === "deeper"),
        "and its callees were reached — a route alone has none",
      );
    } finally { store.close(); }
  });

  test("a namespace-only chain falls back to the file node AND records a gap", () => {
    // The engine's handler is anonymous: every chain row points at a module
    // symbol. Refusing the fallback makes that half of the feature empty, and
    // taking it silently would hide that the attribution got coarser.
    const store = new FactStore(join(dir, "ns.db"));
    try {
      const c = ctx(store);
      const mod = c.sym("", "namespace");
      const fileNode = c.node("file", "svc/server.js");
      const table = c.node("datastore", "postgres://?/goods_receipts");
      c.edge(fileNode, table, "WRITES");
      const r = c.route("POST", "/grn");
      c.chain(r, mod, { name: "(anonymous)" });

      const pack = featurePack(store, "f", { manifest: manifestOf(["svc POST /grn"]) });
      const fileSeed = pack.seeds.find((s) => s.attributedTo === "file");
      assert.ok(fileSeed, "the file node stood in for the missing symbol");
      assert.equal(fileSeed.seed.nodeId, fileNode);
      assert.ok(
        pack.items.some((i) => i.tier === "datastores" && i.name.includes("goods_receipts")),
        "which is the only way the write is reachable",
      );
      assert.ok(
        pack.items.some((i) => i.tier === "gaps" && i.detail.includes("module-scope")),
        "and the coarser attribution is recorded, not silent",
      );
    } finally { store.close(); }
  });

  test("a route-derived symbol does not drag in the other routes that share it", () => {
    // `proxyToEngine` is shared by fifteen routes. Re-expanding from it turns a
    // one-route feature into the whole service — for routes AND for their
    // security chains, which was the second half of this defect.
    const store = new FactStore(join(dir, "shared-proxy.db"));
    try {
      const c = ctx(store);
      const proxy = c.sym("proxyToEngine");
      const mine = c.route("POST", "/grn");
      const other = c.route("POST", "/bill");
      c.chain(mine, proxy, { name: "proxyToEngine" });
      c.chain(other, proxy, { name: "proxyToEngine" });
      c.chain(mine, null, { name: "checkUserAuth", checkKind: "auth", position: 1 });
      c.chain(other, null, { name: "checkBillAuth", checkKind: "auth", position: 1 });

      const pack = featurePack(store, "f", { manifest: manifestOf(["svc POST /grn"]) });
      const security = pack.items.filter((i) => i.tier === "security");
      assert.deepEqual(security.map((i) => i.name), ["checkUserAuth"]);
      assert.ok(
        !pack.items.some((i) => i.where.includes("/bill")),
        "nothing from the unrelated route leaked in",
      );
    } finally { store.close(); }
  });
});

describe("budget", () => {
  const wide = (name: string) => {
    const store = new FactStore(join(dir, name));
    const c = ctx(store);
    const seed = c.sym("seed");
    for (let i = 0; i < 40; i += 1) c.edge(seed, c.sym(`callee${i}`), "CALLS");
    store.insertUnresolved({
      srcNodeId: seed, kind: "call", targetHint: "mystery", reason: "dynamic dispatch",
      fileId: c.fileId, line: 5, runId: c.runId,
    });
    return { store, manifest: manifestOf([SYM("svc", "seed")]) };
  };

  test("a tier that does not fit is CUT, with the true total reported", () => {
    // `context_pack` drops the whole tier. Cutting keeps the most-shared rows
    // and still states how many there were — impact's R39 rule, cut the list
    // and never the count.
    const { store, manifest } = wide("cut.db");
    try {
      const pack = featurePack(store, "f", { manifest, budget: 400 });
      const cut = pack.truncatedTiers.find((t) => t.tier === "callees");
      assert.ok(cut, "the cut is recorded");
      assert.equal(cut.total, 40, "the count is exact, not the shown length");
      assert.ok(cut.shown < 40 && cut.shown > 0, `partial, got ${cut.shown}`);
      assert.equal(pack.items.filter((i) => i.tier === "callees").length, cut.shown);
    } finally { store.close(); }
  });

  test("gaps survive a budget of 1", () => {
    const { store, manifest } = wide("gaps.db");
    try {
      const pack = featurePack(store, "f", { manifest, budget: 1 });
      assert.ok(pack.includedTiers.includes("gaps"));
      assert.equal(pack.items.filter((i) => i.tier === "gaps").length, 1);
      assert.ok(featurePackToToon(pack).includes("mystery"));
    } finally { store.close(); }
  });

  test("the budget is shared, not divided by seed count", () => {
    // Two seeds must not each get half the depth. The tier order is already a
    // global priority statement; splitting would override it arbitrarily.
    const store = new FactStore(join(dir, "shared-budget.db"));
    try {
      const c = ctx(store);
      const a = c.sym("alpha"), b = c.sym("beta");
      for (let i = 0; i < 20; i += 1) {
        c.edge(a, c.sym(`a${i}`), "CALLS");
        c.edge(b, c.sym(`b${i}`), "CALLS");
      }
      const one = featurePack(store, "f", { manifest: manifestOf([SYM("svc", "alpha")]), budget: 3000 });
      const two = featurePack(store, "f", {
        manifest: manifestOf([SYM("svc", "alpha"), SYM("svc", "beta")]), budget: 3000,
      });
      assert.ok(
        two.items.filter((i) => i.tier === "callees").length >
        one.items.filter((i) => i.tier === "callees").length,
        "adding a seed adds context rather than halving what each gets",
      );
    } finally { store.close(); }
  });
});

describe("resolution is honest about what it could not do", () => {
  test("a stale entry becomes an unresolved seed and the pack still renders", () => {
    const store = new FactStore(join(dir, "stale.db"));
    try {
      const c = ctx(store);
      c.sym("alive");
      const pack = featurePack(store, "f", {
        manifest: manifestOf([SYM("svc", "alive"), SYM("svc", "renamedAway")]),
      });
      assert.equal(pack.unresolvedSeeds.length, 1);
      assert.ok(pack.unresolvedSeeds[0]!.spec.includes("renamedAway"));
      assert.equal(pack.seeds.length, 1, "the good seed still produced a pack");
      assert.ok(featurePackToToon(pack).includes("unresolvedSeeds"));
    } finally { store.close(); }
  });

  test("the pack says whether the manifest or a search answered", () => {
    const store = new FactStore(join(dir, "origin.db"));
    try {
      const c = ctx(store);
      c.sym("alpha");
      const pack = featurePack(store, "The Feature", { manifest: manifestOf([SYM("svc", "alpha")]) });
      assert.equal(pack.feature.matchedBy, "name");
      assert.equal(pack.seeds[0]!.origin, "manifest");

      // No manifest: it falls through to search and says so rather than
      // implying a person reviewed the answer.
      const none = featurePack(store, "alpha", { manifest: null });
      assert.ok(["search", "none"].includes(none.feature.matchedBy));
    } finally { store.close(); }
  });

  test("explicit entries override the manifest", () => {
    const store = new FactStore(join(dir, "explicit.db"));
    try {
      const c = ctx(store);
      c.sym("alpha"); c.sym("beta");
      const pack = featurePack(store, "The Feature", {
        manifest: manifestOf([SYM("svc", "alpha")]),
        entries: [SYM("svc", "beta")],
      });
      assert.equal(pack.feature.matchedBy, "explicit");
      assert.deepEqual(pack.seeds.map((s) => s.seed.display), ["beta"]);
    } finally { store.close(); }
  });
});

describe("the document", () => {
  test("it opens by defining its own vocabulary", () => {
    // A model that meets `inferred` before being told what it means has
    // already read it as fact. The legend leads; it does not trail.
    const store = new FactStore(join(dir, "render.db"));
    try {
      const c = ctx(store);
      c.sym("alpha");
      const text = featurePackToToon(
        featurePack(store, "f", { manifest: manifestOf([SYM("svc", "alpha")]) }),
      );
      assert.ok(text.startsWith("read:"), "the legend is the first line");
      assert.ok(text.includes("inferred=a parser guessed it"));
      assert.ok(text.includes("gapsNote:"), "and the gaps are explained, not just listed");
    } finally { store.close(); }
  });

  test("the tier order is the documented one", () => {
    assert.deepEqual([...FEATURE_TIERS], [
      "feature", "entrypoints", "security", "callees", "cfg", "callers",
      "impact", "config", "datastores", "transitive", "prose", "gaps",
    ] satisfies FeatureTier[]);
  });

  test("gaps cannot be skipped, however the caller asks", () => {
    const store = new FactStore(join(dir, "skip.db"));
    try {
      const c = ctx(store);
      const seed = c.sym("alpha");
      store.insertUnresolved({
        srcNodeId: seed, kind: "call", targetHint: "mystery", reason: "dynamic",
        fileId: c.fileId, line: 5, runId: c.runId,
      });
      const pack = featurePack(store, "f", {
        manifest: manifestOf([SYM("svc", "alpha")]),
        skipTiers: ["gaps", "callees"],
      });
      assert.equal(pack.items.filter((i) => i.tier === "gaps").length, 1, "gaps ignored the skip");
      assert.equal(pack.items.filter((i) => i.tier === "callees").length, 0, "callees honoured it");
    } finally { store.close(); }
  });

  test("model prose is never mixed into the extracted items", () => {
    const store = new FactStore(join(dir, "prose.db"));
    try {
      const c = ctx(store);
      c.sym("alpha");
      const pack = featurePack(store, "f", {
        manifest: manifestOf([SYM("svc", "alpha")]),
        prose: [{
          about: "alpha", scope: "function", text: "does a thing",
          model: "m", provider: "local", generatedAt: "2026-01-01",
          origin: "model-generated",
        }],
      });
      assert.equal(pack.items.some((i) => i.detail.includes("does a thing")), false);
      assert.equal(pack.prose.length, 1);
      assert.ok(featurePackToToon(pack).includes("MODEL-GENERATED"));
    } finally { store.close(); }
  });

  test("with nothing injected there is no prose at all", () => {
    // Proof the packer has no path of its own to the LLM cache.
    const store = new FactStore(join(dir, "no-prose.db"));
    try {
      const c = ctx(store);
      c.sym("alpha");
      const pack = featurePack(store, "f", { manifest: manifestOf([SYM("svc", "alpha")]) });
      assert.deepEqual(pack.prose, []);
    } finally { store.close(); }
  });
});

// ---------------------------------------------------------------------------
// The impact tier (P3-T11, R84) — the blast radius, minus what other tiers said
// ---------------------------------------------------------------------------
describe("the impact tier", () => {
  test("it leads with a verdict carrying COUNTS, not another list", () => {
    // "proxyToEngine serves 15 routes" is the whole answer to "what else
    // breaks if I change GRN creation", and it is one row. Ranking by kind
    // also means a budget cut keeps the summary and drops the enumeration.
    const store = new FactStore(join(dir, "verdict.db"));
    try {
      const c = ctx(store);
      const proxy = c.sym("proxyToEngine");
      for (const url of ["/grn", "/po", "/bill"]) {
        const r = c.route("POST", url);
        c.edge(r, proxy, "HANDLES");
        c.chain(r, proxy, { name: "proxyToEngine" });
      }
      const pack = featurePack(store, "f", { manifest: manifestOf([SYM("svc", "proxyToEngine")]) });
      const impact = pack.items.filter((i) => i.tier === "impact");
      assert.equal(impact[0]!.kind, "verdict", "the summary is first, not alphabetical");
      assert.ok(impact[0]!.detail.includes("routes=3"));
    } finally { store.close(); }
  });

  test("a route already listed as an entry point is not repeated", () => {
    const store = new FactStore(join(dir, "nodup.db"));
    try {
      const c = ctx(store);
      const proxy = c.sym("proxyToEngine");
      const mine = c.route("POST", "/grn");
      const other = c.route("POST", "/bill");
      for (const r of [mine, other]) {
        c.edge(r, proxy, "HANDLES");
        c.chain(r, proxy, { name: "proxyToEngine" });
      }
      const pack = featurePack(store, "f", { manifest: manifestOf(["svc POST /grn"]) });
      const routes = pack.items.filter((i) => i.tier === "impact" && i.kind === "route");
      assert.deepEqual(routes.map((r) => r.name), ["POST /bill"],
        "only the OTHER route the shared proxy serves — the delta, not the whole list");
    } finally { store.close(); }
  });

  test("direct callers are never re-emitted — that is the callers tier", () => {
    // Repeating them would inflate the document and imply corroboration where
    // there is a single source.
    const store = new FactStore(join(dir, "nocallers.db"));
    try {
      const c = ctx(store);
      const seed = c.sym("target");
      c.edge(c.sym("caller1"), seed, "CALLS");
      const pack = featurePack(store, "f", { manifest: manifestOf([SYM("svc", "target")]) });
      assert.ok(pack.items.some((i) => i.tier === "callers" && i.name === "caller1"));
      assert.ok(
        !pack.items.some((i) => i.tier === "impact" && i.name === "caller1"),
        "the impact tier carries only what no other tier has",
      );
    } finally { store.close(); }
  });

  test("a high fan-in symbol is called a utility rather than listed against everything", () => {
    // R39: an answer of "everything" is indistinguishable from no answer.
    const store = new FactStore(join(dir, "utility.db"));
    try {
      const c = ctx(store);
      const util = c.sym("nowIso");
      for (let i = 0; i < 15; i += 1) c.edge(c.sym(`caller${i}`), util, "CALLS");
      const pack = featurePack(store, "f", { manifest: manifestOf([SYM("svc", "nowIso")]) });
      const note = pack.items.find((i) => i.tier === "impact" && i.kind === "utility");
      assert.ok(note, "the caution is present");
      assert.ok(note.detail.includes("not as a review list"));
    } finally { store.close(); }
  });

  test("co-users surface coupling no call graph can see", () => {
    const store = new FactStore(join(dir, "couser.db"));
    try {
      const c = ctx(store);
      const mine = c.sym("createGrn");
      const theirs = c.sym("sendMail");
      const env = c.node("config", "env:SERVICE_TOKEN");
      c.edge(mine, env, "READS_CONFIG");
      c.edge(theirs, env, "READS_CONFIG");
      const pack = featurePack(store, "f", { manifest: manifestOf([SYM("svc", "createGrn")]) });
      const shared = pack.items.find((i) => i.tier === "impact" && i.kind === "co-user");
      assert.ok(shared, "the shared env var is reported");
      assert.equal(shared.name, "env:SERVICE_TOKEN");
      assert.ok(shared.detail.includes("sendMail") || shared.detail.includes("svc"));
    } finally { store.close(); }
  });

  test("skipTiers can turn the whole tier off", () => {
    const store = new FactStore(join(dir, "noimpact.db"));
    try {
      const c = ctx(store);
      c.sym("alpha");
      const pack = featurePack(store, "f", {
        manifest: manifestOf([SYM("svc", "alpha")]), skipTiers: ["impact"],
      });
      assert.equal(pack.items.filter((i) => i.tier === "impact").length, 0);
    } finally { store.close(); }
  });
});
