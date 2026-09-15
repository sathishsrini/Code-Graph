// ============================================================================
// feature_pack  —  task P3-T9  (requirement R82)
// ============================================================================
// "I need to change GRN creation." One document, token-budgeted, carrying the
// entry points, what runs on them, what they call, what breaks, and the gaps.
//
// `context_pack` (P1-T15) answers the same question for ONE function. A
// business feature is not one function. On this corpus "GRN creation" spans
// two services and a front end, its router handler is the generic
// `proxyToEngine` shared by fifteen routes, and its engine handler is
// anonymous — so a single-seed pack cannot express it at any budget.
//
// Three things this does that the single-seed pack does not:
//
//   N seeds, merged      Items are deduplicated across seeds and carry `via`,
//                        the seeds that pulled them in. A shared spine appears
//                        once, and the fact that it is shared is visible.
//
//   shared budget        Not split N ways: a two-seed feature would otherwise
//                        get half the depth of a one-seed one, when the tier
//                        order is already a global statement of priority.
//
//   tiers truncate       `context_pack` drops a whole tier that does not fit.
//                        Here a tier is cut to what fits and reports
//                        `{shown, total}` — the same rule `impact` already
//                        follows for routes (R39): cut the LIST, never the
//                        count. Within a tier, items sort by how many seeds
//                        reached them, so the spine survives a tight budget.
//
// **This module cannot read model-generated prose, structurally.** It declares
// `ProseNote` and takes notes through `options.prose`; the reader that produces
// them lives in `src/llm/` and imports the type from here. So the dependency
// points the safe way and there is no code path from the packer to the LLM
// cache — the same discipline as `writeSummary` taking no `GraphWriter`. Prose
// is also not a `FeatureItem` and never enters `pack.items`: mixing extracted
// fact with model output is a compile error rather than a review miss.
// ============================================================================

import type { FactStore } from "../store/db.ts";
import { encodeToon, estimateTokens } from "../serializers/toon.ts";
import {
  dumpBaseline, gapsFor, neighbours, routesFor, securityFor, touching,
  transitiveCallees, type PackedItem, type TokenDelta,
} from "./context-pack.ts";
import { resolveSeed, SeedNotFound, type ImpactSeed } from "./impact.ts";
import { search } from "./workflow.ts";
import { matchFeature, type FeatureManifest } from "../config/features.ts";
import { cfgRowsFor, CFG_NOTE } from "./cfg-tier.ts";

/**
 * Priority order. `feature` first, `gaps` last, and both are reserved.
 *
 * `cfg` sits above `callers` and below `security` (P3-T10). It is the only
 * tier that says WHERE INSIDE a function the feature lives — on this corpus
 * GRN is an `else` branch at lines 205-211 of a 110-line proxy — and you
 * cannot make the change without it, while `callers` tells you what to check
 * afterwards. It stays below `security` because accidentally deleting a check
 * is a worse outcome than a slower edit.
 *
 * `prose` is second-to-last, above `gaps` only, and is never reserved: it is
 * the one section that is not extracted fact, so it must never be the thing
 * that evicts a fact under a tight budget.
 */
export const FEATURE_TIERS = [
  "feature", "entrypoints", "security", "callees", "cfg", "callers",
  "impact", "config", "datastores", "transitive", "prose", "gaps",
] as const;
export type FeatureTier = (typeof FEATURE_TIERS)[number];

/** Tiers whose cost is reserved before the walk, and which are never cut. */
const RESERVED: ReadonlySet<FeatureTier> = new Set(["feature", "gaps"]);

export interface FeatureItem extends Omit<PackedItem, "tier"> {
  tier: FeatureTier;
  /** Display names of the seeds that reached this. Length is the sort key. */
  via: string[];
}

export interface ResolvedSeed {
  seed: ImpactSeed;
  /** Verbatim, as asked for — a manifest line, an --entry, or a search hit. */
  spec: string;
  origin: "manifest" | "search" | "explicit";
  /** The route key this was expanded from, when it was. */
  derivedFrom: string | null;
  /**
   * Whether the seed is the symbol itself or the file that owns it.
   *
   * `file` is not a fallback to be embarrassed about: the engine's GRN handler
   * is anonymous and its `goods_receipts` writes hang off the file node, so
   * refusing file attribution would make half the feature come back empty. It
   * is labelled because the coupling is real but coarser than a function.
   */
  attributedTo: "symbol" | "file";
}

export interface UnresolvedSeed {
  spec: string;
  reason: string;
  candidates: Array<{ key: string; display: string }>;
}

/**
 * One cached model summary. NOT a `FeatureItem`, on purpose — see the header.
 *
 * `origin` is a literal type with one value, never derived from data, so a note
 * cannot be constructed that claims to be anything else.
 */
export interface ProseNote {
  about: string;
  scope: string;
  text: string;
  model: string;
  provider: string;
  generatedAt: string;
  readonly origin: "model-generated";
}

export interface FeaturePack {
  feature: {
    asked: string;
    id: string | null;
    name: string | null;
    matchedBy: "id" | "name" | "alias" | "tokens" | "search" | "explicit" | "none";
    manifestPath: string | null;
    notes: string | null;
  };
  seeds: ResolvedSeed[];
  items: FeatureItem[];
  prose: ProseNote[];
  budget: number;
  usedTokens: number;
  includedTiers: FeatureTier[];
  droppedTiers: FeatureTier[];
  truncatedTiers: Array<{ tier: FeatureTier; shown: number; total: number }>;
  unresolvedSeeds: UnresolvedSeed[];
}

export interface FeaturePackOptions {
  budget?: number;
  /**
   * Default FALSE, unlike `context_pack`.
   *
   * N function bodies would spend the budget on exactly what the structure is
   * meant to replace — `proxyToEngine` alone is 110 lines. M9 recommended this
   * for the single-seed pack and it was never applied; with N seeds it stops
   * being a preference.
   */
  includeSource?: boolean;
  maxSeeds?: number;
  /** Explicit entry points, overriding both manifest and search. */
  entries?: string[];
  manifest?: FeatureManifest | null;
  /** Injected — this module has no path to the cache that holds these. */
  prose?: ProseNote[];
  skipTiers?: FeatureTier[];
}

const DEFAULT_BUDGET = 12000;
const DEFAULT_MAX_SEEDS = 6;

// ---------------------------------------------------------------------------
// Seed resolution
// ---------------------------------------------------------------------------

interface SeedResolution {
  feature: FeaturePack["feature"];
  seeds: ResolvedSeed[];
  unresolved: UnresolvedSeed[];
  /** Chain steps that could not be keyed to a symbol. Gaps, not silence. */
  notes: FeatureItem[];
}

/**
 * Which nodes this feature starts from.
 *
 * Order: explicit `entries`, then the reviewed manifest, then `search`. The
 * pack reports which of the three answered, because "the manifest named these"
 * and "a lexical search guessed these" are different claims and only one of
 * them was reviewed by a person.
 *
 * **Nothing here throws.** A spec that does not resolve becomes an
 * `UnresolvedSeed` carrying the candidates `resolveSeed` offered. A feature
 * with one stale entry still produces a pack — the same "store the gaps"
 * discipline the graph applies to call sites, applied to seed resolution.
 */
export function resolveFeatureSeeds(
  store: FactStore, asked: string, options: FeaturePackOptions = {},
): SeedResolution {
  const maxSeeds = options.maxSeeds ?? DEFAULT_MAX_SEEDS;
  const manifest = options.manifest ?? null;

  let specs: string[] = [];
  let origin: ResolvedSeed["origin"] = "explicit";
  const feature: FeaturePack["feature"] = {
    asked, id: null, name: null, matchedBy: "none",
    manifestPath: manifest?.present ? manifest.path : null, notes: null,
  };

  if (options.entries && options.entries.length > 0) {
    specs = options.entries;
    feature.matchedBy = "explicit";
  } else {
    const hit = manifest ? matchFeature(manifest, asked) : null;
    if (hit) {
      specs = hit.feature.entries.map((e) => e.spec);
      origin = "manifest";
      feature.id = hit.feature.id;
      feature.name = hit.feature.name;
      feature.notes = hit.feature.notes;
      feature.matchedBy = hit.how;
    } else {
      const found = search(store, asked, { topK: maxSeeds });
      specs = found.candidates.map((c) => c.nodeKey);
      origin = "search";
      feature.matchedBy = specs.length > 0 ? "search" : "none";
    }
  }

  const seeds: ResolvedSeed[] = [];
  const unresolved: UnresolvedSeed[] = [];
  const notes: FeatureItem[] = [];
  const seen = new Set<number>();

  const push = (s: ResolvedSeed): void => {
    if (seen.has(s.seed.nodeId)) return;
    seen.add(s.seed.nodeId);
    seeds.push(s);
  };

  for (const spec of specs.slice(0, maxSeeds)) {
    let seed: ImpactSeed;
    try {
      seed = resolveSeed(store, spec);
    } catch (e) {
      unresolved.push({
        spec,
        reason: e instanceof SeedNotFound ? e.message : String(e),
        candidates: e instanceof SeedNotFound ? e.matches.slice(0, 5) : [],
      });
      continue;
    }

    push({ seed, spec, origin, derivedFrom: null, attributedTo: seed.kind === "file" ? "file" : "symbol" });

    // A route is not a symbol: `neighbours()` walks CALLS, and a route carries
    // HANDLES, so seeding a route alone reaches nothing. Expand it.
    if (seed.kind === "route") {
      const expanded = expandRoute(store, seed);
      for (const s of expanded.seeds) push({ ...s, origin, spec });
      notes.push(...expanded.notes);
    }
  }

  return { feature, seeds, unresolved, notes };
}

/**
 * A route's chain, as seeds.
 *
 * Three rules the corpus forces, each of which is wrong to skip:
 *
 * 1. **A `namespace` symbol is not an owner.** Same rule as `reverseClosure`
 *    and `ownerOf`: a module's "callees" are the whole file's. Every skipped
 *    step is recorded as a gap row rather than silently dropped.
 * 2. **If nothing real is left, fall back to the file node.** The engine's GRN
 *    handler is anonymous and every one of its chain rows points at a
 *    namespace, so without this the engine half of the feature is empty — and
 *    the `goods_receipts` writes it exists to show hang off that file node.
 * 3. **A route-derived symbol does NOT re-expand its own routes.** Otherwise
 *    `proxyToEngine`, which fifteen routes share, drags all fifteen in and the
 *    pack becomes "the whole service". The impact tier's utility verdict says
 *    that in one row instead.
 */
function expandRoute(
  store: FactStore, route: ImpactSeed,
): { seeds: ResolvedSeed[]; notes: FeatureItem[] } {
  const rows = store.raw().prepare(
    `SELECT rc.position, rc.name, rc.phase, n.key AS symbol_key, s.symbol_kind,
            f.path AS file_path, rp.name AS repo_name
       FROM route_chain rc
       LEFT JOIN nodes n ON n.id = rc.symbol_node_id
       LEFT JOIN symbols s ON s.node_id = rc.symbol_node_id
       LEFT JOIN files f ON f.id = rc.file_id
       LEFT JOIN repos rp ON rp.id = f.repo_id
      WHERE rc.route_node_id = ?
      ORDER BY rc.position`,
  ).all(route.nodeId) as Array<Record<string, string | number | null>>;

  const seeds: ResolvedSeed[] = [];
  const notes: FeatureItem[] = [];
  const fileKeys = new Set<string>();

  for (const r of rows) {
    const key = r["symbol_key"] as string | null;
    const kind = r["symbol_kind"] as string | null;
    if (r["repo_name"] && r["file_path"]) {
      fileKeys.add(`${r["repo_name"]}/${r["file_path"]}`);
    }
    if (key && kind !== "namespace") {
      try {
        seeds.push({
          seed: resolveSeed(store, key), spec: key, origin: "manifest",
          derivedFrom: route.key, attributedTo: "symbol",
        });
      } catch { /* a chain row pointing at a vanished node is the gap below */ }
      continue;
    }
    notes.push({
      tier: "gaps",
      kind: "chain-step",
      name: String(r["name"] ?? "(anonymous)"),
      detail: key
        ? "handler is module-scope, not a function — attributed to its file"
        : "chain step could not be keyed to a symbol",
      where: `${route.key} #${r["position"]}`,
      via: [route.key],
    });
  }

  if (seeds.length === 0) {
    for (const fileKey of fileKeys) {
      try {
        seeds.push({
          seed: resolveSeed(store, fileKey), spec: fileKey, origin: "manifest",
          derivedFrom: route.key, attributedTo: "file",
        });
      } catch { /* no file node for this path: the gap row above already says so */ }
    }
  }
  return { seeds, notes };
}

// ---------------------------------------------------------------------------
// The pack
// ---------------------------------------------------------------------------

/**
 * Merge key. Two rows describing the same thing from two seeds are one row.
 *
 * `detail` is part of it, and leaving it out was a real bug: a datastore row's
 * kind, name and location are identical for a READ and a WRITE, so the two
 * collapsed and the pack reported that GRN creation *reads* `goods_receipts`
 * while never saying it writes it. The write is the whole feature.
 *
 * JSON rather than a delimiter: no separator character is safe against a SCIP
 * signature, and a NUL one makes the source file unsearchable by grep.
 */
const mergeKey = (i: { kind: string; name: string; detail: string; where: string }): string =>
  JSON.stringify([i.kind, i.name, i.detail, i.where]);

/**
 * The checks on ONE route.
 *
 * Not `securityFor`, which asks a different question — "every route that runs
 * this symbol" — and answers it correctly. Asked about `proxyToEngine`, which
 * fifteen routes share, it returns all fifteen, so a GRN pack listed the
 * checks on `/api/v1/bill` and `/api/v1/po` as part of the feature.
 */
function securityOfRoute(store: FactStore, routeNodeId: number): PackedItem[] {
  return (store.raw().prepare(
    `SELECT rc.check_kind, rc.name, rc.confidence, rc.evidence_kind, rc.position,
            r.service_name, r.method, r.url
       FROM route_chain rc
       JOIN routes r ON r.node_id = rc.route_node_id
      WHERE rc.route_node_id = ? AND rc.check_kind IS NOT NULL
      ORDER BY rc.position`,
  ).all(routeNodeId) as Array<Record<string, string | number | null>>).map((r) => ({
    tier: "security" as const,
    kind: "check",
    name: String(r["name"] ?? "(shape match)"),
    detail: `${r["check_kind"]} [${r["confidence"]}/${r["evidence_kind"]}]`,
    where: `${r["service_name"]} ${r["method"]} ${r["url"]}`,
  }));
}

export function featurePack(
  store: FactStore, asked: string, options: FeaturePackOptions = {},
): FeaturePack {
  const budget = options.budget ?? DEFAULT_BUDGET;
  const skip = new Set(options.skipTiers ?? []);
  // `gaps` cannot be skipped. A pack that hides what it could not see tells
  // the reader the picture is complete, which is the one claim never to make.
  skip.delete("gaps");
  skip.delete("feature");

  const { feature, seeds, unresolved, notes } = resolveFeatureSeeds(store, asked, options);

  const byTier = new Map<FeatureTier, Map<string, FeatureItem>>();
  for (const tier of FEATURE_TIERS) byTier.set(tier, new Map());

  const add = (tier: FeatureTier, item: Omit<FeatureItem, "tier" | "via">, via: string): void => {
    if (skip.has(tier)) return;
    const bucket = byTier.get(tier)!;
    const key = mergeKey(item);
    const existing = bucket.get(key);
    if (existing) {
      if (!existing.via.includes(via)) existing.via.push(via);
      return;
    }
    bucket.set(key, { ...item, tier, via: [via] });
  };

  const adopt = (tier: FeatureTier, items: PackedItem[], via: string): void => {
    for (const i of items) add(tier, { kind: i.kind, name: i.name, detail: i.detail, where: i.where }, via);
  };

  for (const resolved of seeds) {
    const { seed } = resolved;
    const via = seed.display;

    add("entrypoints", {
      kind: seed.kind,
      name: seed.display,
      detail: [
        resolved.origin,
        resolved.derivedFrom ? `via ${resolved.derivedFrom}` : "",
        resolved.attributedTo === "file" ? "[file-scope]" : "",
      ].filter(Boolean).join(" "),
      where: seed.file ?? seed.key,
    }, via);

    if (seed.kind === "route") {
      // A route's own chain, and nothing else — a route has no callees.
      adopt("security", securityOfRoute(store, seed.nodeId), via);
      continue;
    }

    adopt("callees", neighbours(store, seed.nodeId, "out"), via);
    adopt("callers", neighbours(store, seed.nodeId, "in"), via);
    // Rule 3 again. `securityFor` returns the checks on EVERY route running
    // this symbol, which for a shared proxy is the whole service. A symbol
    // reached by expanding a route already had that route's checks recorded
    // above; only a directly-named symbol asks the broader question.
    if (resolved.derivedFrom === null) adopt("security", securityFor(store, seed.nodeId), via);
    adopt("config", touching(store, seed, "config", ["READS_CONFIG"]), via);
    adopt("datastores", touching(store, seed, "datastore", ["READS", "WRITES"]), via);
    adopt("transitive", transitiveCallees(store, seed.nodeId), via);
    adopt("gaps", gapsFor(store, seed.nodeId), via);

    // Where inside this function the feature actually lives (P3-T10).
    for (const row of cfgRowsFor(store, seed.nodeId, seed.file)) add("cfg", row, via);

    // Rule 3: a symbol reached BY expanding a route does not drag its own
    // fifteen routes back in. Only a seed the caller actually named does.
    if (resolved.derivedFrom === null) adopt("entrypoints", routesFor(store, seed.nodeId), via);
  }

  for (const note of notes) {
    add(note.tier, { kind: note.kind, name: note.name, detail: note.detail, where: note.where }, note.via[0] ?? asked);
  }

  const prose = skip.has("prose") ? [] : options.prose ?? [];
  return budgeted(feature, seeds, unresolved, byTier, prose, budget);
}

/** `file:line` order — by file, then by line NUMERICALLY, not as text. */
function compareWhere(a: string, b: string): number {
  const cut = (w: string): [string, number] => {
    const i = w.lastIndexOf(":");
    const n = i < 0 ? NaN : Number(w.slice(i + 1));
    return Number.isFinite(n) ? [w.slice(0, i), n] : [w, Number.MAX_SAFE_INTEGER];
  };
  const [fa, la] = cut(a);
  const [fb, lb] = cut(b);
  if (fa !== fb) return fa < fb ? -1 : 1;
  return la - lb;
}

/**
 * Admit tiers in priority order, cutting rather than dropping where possible.
 *
 * The header reservation (`feature`, `seeds`, `unresolvedSeeds`, `gaps`) is
 * charged before the walk starts, so no budget is tight enough to remove the
 * sections that say what was asked, what answered, and what is missing.
 */
function budgeted(
  feature: FeaturePack["feature"],
  seeds: ResolvedSeed[],
  unresolved: UnresolvedSeed[],
  byTier: Map<FeatureTier, Map<string, FeatureItem>>,
  prose: ProseNote[],
  budget: number,
): FeaturePack {
  const sorted = new Map<FeatureTier, FeatureItem[]>();
  for (const [tier, bucket] of byTier) {
    // Most-shared first: the spine of the feature is what survives a cut.
    // Within that, `cfg` orders by POSITION and everything else by name. A
    // list of callees has no inherent order, but a decision structure does —
    // alphabetised control flow reads as L170, L273, L262, L238, and a reader
    // trying to follow the function has to re-sort it by hand. Cutting the
    // tier then keeps the top of the function, which is where reading starts.
    const byPosition = tier === "cfg";
    sorted.set(tier, [...bucket.values()].sort((a, b) =>
      b.via.length - a.via.length ||
      (byPosition ? compareWhere(a.where, b.where) : 0) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
  }

  const gaps = sorted.get("gaps") ?? [];
  let used = estimateTokens(encodeToon({
    feature, seeds: seeds.map(seedRow), unresolvedSeeds: unresolved, gaps,
  }));

  const items: FeatureItem[] = [];
  const included: FeatureTier[] = ["feature"];
  const dropped: FeatureTier[] = [];
  const truncated: FeaturePack["truncatedTiers"] = [];

  for (const tier of FEATURE_TIERS) {
    if (RESERVED.has(tier)) continue;
    const all = sorted.get(tier) ?? [];
    if (all.length === 0) { included.push(tier); continue; }

    const costOf = (rows: FeatureItem[]) => estimateTokens(encodeToon({ [tier]: rows.map(itemRow) }));
    const full = costOf(all);
    if (used + full <= budget) {
      items.push(...all);
      used += full;
      included.push(tier);
      continue;
    }

    // Binary-search the longest prefix that fits. ~8 encodes, against a linear
    // walk that could be hundreds on a wide tier.
    let lo = 0;
    let hi = all.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (used + costOf(all.slice(0, mid)) <= budget) lo = mid; else hi = mid - 1;
    }
    if (lo > 0) {
      const shown = all.slice(0, lo);
      items.push(...shown);
      used += costOf(shown);
      included.push(tier);
    } else {
      dropped.push(tier);
    }
    // Recorded either way: `shown: 0` is a drop AND a count, and the count is
    // the part a reader needs to know they are missing something.
    truncated.push({ tier, shown: lo, total: all.length });
  }

  if (prose.length > 0) {
    const cost = estimateTokens(encodeToon({ prose }));
    if (used + cost <= budget) used += cost;
    else prose = [];  // never reserved; a fact outranks a paraphrase
  }

  items.push(...gaps);
  included.push("gaps");

  return {
    feature, seeds, items, prose, budget, usedTokens: used,
    includedTiers: included, droppedTiers: dropped, truncatedTiers: truncated,
    unresolvedSeeds: unresolved,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const seedRow = (s: ResolvedSeed) => ({
  spec: s.spec,
  resolved: s.seed.display,
  kind: s.seed.kind,
  where: s.seed.file ?? s.seed.key,
  origin: s.origin,
  via: s.derivedFrom ?? "",
  attributedTo: s.attributedTo,
});

const itemRow = (i: FeatureItem) => ({
  name: i.name, detail: i.detail, where: i.where, via: i.via.join("+"),
});

/**
 * The document.
 *
 * It opens with a `read:` line rather than ending with a legend. A model that
 * meets `inferred` before it has been told what `inferred` means has already
 * read it as fact.
 */
export function featurePackToToon(pack: FeaturePack): string {
  const hasCfg = pack.items.some((i) => i.tier === "cfg");
  const head: Record<string, unknown> = {
    read:
      "certain=compiler resolved it · inferred=a parser guessed it · " +
      "observed=runtime saw it · unresolved=a known gap. " +
      "[file-scope] means attributed to the file, not the function." +
      (hasCfg ? ` ${CFG_NOTE}` : ""),
    feature: pack.feature.name ?? pack.feature.asked,
    asked: pack.feature.asked,
    featureId: pack.feature.id ?? "",
    matchedBy: pack.feature.matchedBy,
    manifest: pack.feature.manifestPath ?? "(none)",
    budget: pack.budget,
    used: pack.usedTokens,
  };
  if (pack.feature.notes) head["notes"] = pack.feature.notes;
  head["seeds"] = pack.seeds.map(seedRow);

  for (const tier of FEATURE_TIERS) {
    if (tier === "feature" || tier === "prose" || tier === "gaps") continue;
    const rows = pack.items.filter((i) => i.tier === tier);
    if (rows.length > 0) head[tier] = rows.map(itemRow);
  }

  const out: string[] = [encodeToon(head)];

  if (pack.prose.length > 0) {
    // The label is a line of its own, before the block, because a column
    // header is read after the rows it describes.
    out.push(encodeToon({
      proseOrigin:
        "MODEL-GENERATED PROSE. Not extracted fact. Every other section in " +
        "this document came from a compiler, a boot dump or a parser. Do not " +
        "cite this; verify it.",
      prose: pack.prose.map((p) => ({
        about: p.about, scope: p.scope, model: p.model,
        generated: p.generatedAt, text: p.text,
      })),
    }));
  }

  const tail: Record<string, unknown> = {};
  if (pack.truncatedTiers.length > 0) tail["truncated"] = pack.truncatedTiers;
  if (pack.droppedTiers.length > 0) tail["droppedForBudget"] = pack.droppedTiers;
  tail["unresolvedSeeds"] = pack.unresolvedSeeds.map((u) => ({
    spec: u.spec, reason: u.reason, candidates: u.candidates.length,
  }));
  tail["gapsNote"] =
    "Call sites the engine could NOT resolve, plus chain steps it could not " +
    "key to a symbol. Empty means nothing was missed, never that nothing was " +
    "found.";
  tail["gaps"] = pack.items.filter((i) => i.tier === "gaps").map(itemRow);
  out.push(encodeToon(tail));

  return `${out.join("\n")}\n`;
}

/** R71's ratio, for a pack that spans several repos. */
export function measureFeatureDelta(store: FactStore, pack: FeaturePack): TokenDelta {
  const paths = new Set<string>();
  for (const s of pack.seeds) {
    if (s.seed.kind === "file") paths.add(s.seed.key);
    else if (s.seed.file) paths.add(s.seed.file);
  }
  for (const item of pack.items) {
    const file = item.where.split(":")[0];
    if (file && file.includes(".")) paths.add(file);
  }
  const { chars, files } = dumpBaseline(store, paths);
  const packTokens = estimateTokens(featurePackToToon(pack));
  const dumpTokens = estimateTokens("x".repeat(chars));
  return {
    packTokens, dumpTokens, files,
    ratio: dumpTokens === 0 ? 0 : packTokens / dumpTokens,
  };
}
