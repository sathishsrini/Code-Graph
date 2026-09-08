// ============================================================================
// context_pack  —  task P1-T15  (requirements R42, R44, R71)
// ============================================================================
// "What is the minimum context needed to edit this function?"
//
// This is the query the project exists to justify. R71 makes that explicit: the
// ratio of a packed context to dumping the files is the number that decides
// whether any of this was worth building, and it is measured, not asserted.
//
// The mechanism is a budgeted walk over NINE PRIORITY TIERS. Tiers are filled
// in order and the walk stops the moment the budget is spent, so what survives
// a small budget is what matters most — rather than whatever the traversal
// happened to reach first.
//
//   1  the seed itself, WITH source
//   2  what it calls                    you cannot edit a function without these
//   3  who calls it                     changing the signature breaks them
//   4  the routes it runs on            what breaks in production
//   5  security context on those routes what you must not accidentally remove
//   6  config it reads                  deployment coupling
//   7  datastores it touches            data coupling
//   8  transitive callees, depth 2      the next ring, signatures only
//   9  unresolved gaps                  what the engine could NOT see
//
// **Tier 9 is never dropped**, whatever the budget. A pack that silently omits
// the gaps tells the reader the picture is complete, which is the one claim
// this engine must never make. It is emitted first into the reservation and
// rendered last.
//
// R42's other rule: no raw source below tier 1 unless asked. Everything else is
// a signature, a name and a position — enough to know a thing exists and where
// to look, which is what a reader actually needs from a neighbour.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FactStore } from "../store/db.ts";
import { displayNameOf } from "../static/scip/symbol.ts";
import { encodeToon, estimateTokens } from "../serializers/toon.ts";
import { resolveSeed, type ImpactSeed } from "./impact.ts";

export const TIERS = [
  "seed", "callees", "callers", "routes", "security",
  "config", "datastores", "transitive", "gaps",
] as const;
export type Tier = (typeof TIERS)[number];

export interface PackedItem {
  tier: Tier;
  kind: string;
  name: string;
  detail: string;
  where: string;
}

export interface ContextPack {
  seed: { name: string; key: string; file: string | null; signature: string | null };
  /** Raw source, tier 1 only. Null when the file could not be read. */
  source: string | null;
  items: PackedItem[];
  budget: number;
  usedTokens: number;
  /** Tiers that were reached before the budget ran out. */
  includedTiers: Tier[];
  /** Tiers dropped for budget. Named, so the reader knows what is missing. */
  droppedTiers: Tier[];
}

export interface PackOptions {
  /** Token budget. The pack stops adding tiers once this is spent. */
  budget?: number;
  /** Include raw source for tier 1. Default true; R42 forbids it below tier 1. */
  includeSource?: boolean;
  /** Repo roots by repo name, so tier-1 source can be read from disk. */
  repoRoots?: Map<string, string>;
}

const DEFAULT_BUDGET = 4000;

// ---------------------------------------------------------------------------

export function contextPack(
  store: FactStore, query: string, options: PackOptions = {},
): ContextPack {
  const budget = options.budget ?? DEFAULT_BUDGET;
  const seed = resolveSeed(store, query);
  const db = store.raw();

  const signature = (db.prepare(
    "SELECT signature FROM symbols WHERE node_id = ?",
  ).get(seed.nodeId) as { signature: string | null } | undefined)?.signature ?? null;

  // Gathered before budgeting so a tier can be measured before it is admitted.
  const byTier = new Map<Tier, PackedItem[]>();
  const put = (tier: Tier, items: PackedItem[]) => byTier.set(tier, items);

  put("callees", neighbours(store, seed.nodeId, "out"));
  put("callers", neighbours(store, seed.nodeId, "in"));
  put("routes", routesFor(store, seed.nodeId));
  put("security", securityFor(store, seed.nodeId));
  put("config", touching(store, seed, "config", ["READS_CONFIG"]));
  put("datastores", touching(store, seed, "datastore", ["READS", "WRITES"]));
  put("transitive", transitiveCallees(store, seed.nodeId));
  put("gaps", gapsFor(store, seed.nodeId));

  const source = options.includeSource === false
    ? null
    : readSeedSource(store, seed, options.repoRoots);

  const seedItem: PackedItem = {
    tier: "seed", kind: "symbol", name: seed.display,
    detail: signature ?? "", where: seed.file ?? "",
  };

  // Tier 9 is reserved up front, so a tight budget cannot silently remove the
  // one section that says what is missing.
  const gaps = byTier.get("gaps") ?? [];
  const reserved = estimateTokens(encodeToon({ gaps }));

  const items: PackedItem[] = [seedItem];
  let used = estimateTokens(encodeToon({ seed: seedItem })) +
    (source ? estimateTokens(source) : 0) + reserved;

  const included: Tier[] = ["seed"];
  const dropped: Tier[] = [];

  for (const tier of TIERS) {
    if (tier === "seed" || tier === "gaps") continue;
    const tierItems = byTier.get(tier) ?? [];
    if (tierItems.length === 0) { included.push(tier); continue; }

    const cost = estimateTokens(encodeToon({ [tier]: tierItems }));
    if (used + cost > budget) {
      // Named, not silently truncated. A reader who knows `transitive` was
      // dropped can ask for a bigger budget; one who does not assumes there
      // was nothing there.
      dropped.push(tier);
      continue;
    }
    items.push(...tierItems);
    used += cost;
    included.push(tier);
  }

  items.push(...gaps);
  included.push("gaps");

  return {
    seed: { name: seed.display, key: seed.key, file: seed.file, signature },
    source,
    items,
    budget,
    usedTokens: used,
    includedTiers: included,
    droppedTiers: dropped,
  };
}

// ---------------------------------------------------------------------------

function neighbours(store: FactStore, nodeId: number, dir: "in" | "out"): PackedItem[] {
  const [self, other] = dir === "out"
    ? ["src_node_id", "dst_node_id"]
    : ["dst_node_id", "src_node_id"];

  return (store.raw().prepare(
    `SELECT DISTINCT n.kind, n.key, e.type, e.confidence, s.signature,
            f.path AS file, s.start_line AS line
       FROM edges e
       JOIN nodes n ON n.id = e.${other}
       LEFT JOIN symbols s ON s.node_id = n.id
       LEFT JOIN files f ON f.id = s.file_id
      WHERE e.${self} = ? AND e.type IN ('CALLS', 'CALLS_EXTERNAL')
      ORDER BY n.key`,
  ).all(nodeId) as Array<Record<string, string | number | null>>).map((r) => ({
    tier: dir === "out" ? "callees" as const : "callers" as const,
    kind: String(r["kind"]),
    name: String(r["kind"]) === "symbol" ? displayNameOf(String(r["key"])) : String(r["key"]),
    detail: `${r["type"]} [${r["confidence"]}]${r["signature"] ? ` ${r["signature"]}` : ""}`,
    where: r["file"] ? `${r["file"]}:${r["line"] ?? "?"}` : "",
  }));
}

/** Routes that run this symbol — either on their chain, or one call away. */
function routesFor(store: FactStore, nodeId: number): PackedItem[] {
  return (store.raw().prepare(
    `SELECT DISTINCT r.service_name, r.method, r.url
       FROM routes r
       JOIN nodes rn ON rn.id = r.node_id
      WHERE EXISTS (
              SELECT 1 FROM route_chain rc
               WHERE rc.route_node_id = r.node_id AND rc.symbol_node_id = ?)
         OR EXISTS (
              SELECT 1 FROM edges h
                JOIN edges c ON c.src_node_id = h.dst_node_id
               WHERE h.src_node_id = r.node_id AND h.type = 'HANDLES'
                 AND c.type = 'CALLS' AND c.dst_node_id = ?)
      ORDER BY r.service_name, r.url, r.method`,
  ).all(nodeId, nodeId) as Array<{ service_name: string; method: string; url: string }>)
    .map((r) => ({
      tier: "routes" as const, kind: "route",
      name: `${r.method} ${r.url}`, detail: "", where: r.service_name,
    }));
}

/**
 * Security checks on the routes this symbol runs on.
 *
 * Tier 5 because it is the context most easily destroyed by an edit that looks
 * local: a handler refactor that drops a sentinel return removes a check, and
 * nothing in the call graph would show it as a deletion.
 */
function securityFor(store: FactStore, nodeId: number): PackedItem[] {
  return (store.raw().prepare(
    `SELECT DISTINCT rc.check_kind, rc.name, rc.confidence, rc.evidence_kind,
            r.service_name, r.method, r.url
       FROM route_chain rc
       JOIN routes r ON r.node_id = rc.route_node_id
      WHERE rc.check_kind IS NOT NULL
        AND rc.route_node_id IN (
              SELECT rc2.route_node_id FROM route_chain rc2 WHERE rc2.symbol_node_id = ?
              UNION
              SELECT h.src_node_id FROM edges h
                JOIN edges c ON c.src_node_id = h.dst_node_id
               WHERE h.type = 'HANDLES' AND c.type = 'CALLS' AND c.dst_node_id = ?)
      ORDER BY r.url, rc.position`,
  ).all(nodeId, nodeId) as Array<Record<string, string | null>>).map((r) => ({
    tier: "security" as const,
    kind: "check",
    name: r["name"] ?? "(shape match)",
    detail: `${r["check_kind"]} [${r["confidence"]}/${r["evidence_kind"]}]`,
    where: `${r["service_name"]} ${r["method"]} ${r["url"]}`,
  }));
}

function touching(
  store: FactStore, seed: ImpactSeed, kind: string, types: string[],
): PackedItem[] {
  const q = types.map(() => "?").join(", ");
  const sources = [seed.nodeId, ...(seed.fileNodeId && seed.fileNodeId !== seed.nodeId
    ? [seed.fileNodeId] : [])];
  const placeholders = sources.map(() => "?").join(", ");

  return (store.raw().prepare(
    `SELECT DISTINCT n.key, e.type, e.src_node_id
       FROM edges e JOIN nodes n ON n.id = e.dst_node_id
      WHERE e.src_node_id IN (${placeholders}) AND n.kind = ? AND e.type IN (${q})
      ORDER BY n.key`,
  ).all(...sources, kind, ...types) as Array<Record<string, string | number>>).map((r) => ({
    tier: kind === "config" ? "config" as const : "datastores" as const,
    kind,
    name: String(r["key"]),
    detail: String(r["type"]),
    // The file-scope caveat travels with the item, so a reader never takes a
    // module-level config read as this function's own.
    where: Number(r["src_node_id"]) === seed.nodeId ? "" : "[file-scope]",
  }));
}

function transitiveCallees(store: FactStore, nodeId: number): PackedItem[] {
  return (store.raw().prepare(
    `SELECT DISTINCT n.key, s.signature, f.path AS file, s.start_line AS line
       FROM edges e1
       JOIN edges e2 ON e2.src_node_id = e1.dst_node_id
       JOIN nodes n ON n.id = e2.dst_node_id
       LEFT JOIN symbols s ON s.node_id = n.id
       LEFT JOIN files f ON f.id = s.file_id
      WHERE e1.src_node_id = ? AND e1.type = 'CALLS' AND e2.type = 'CALLS'
        AND n.kind = 'symbol' AND n.id <> ?
      ORDER BY n.key`,
  ).all(nodeId, nodeId) as Array<Record<string, string | number | null>>).map((r) => ({
    tier: "transitive" as const, kind: "symbol",
    name: displayNameOf(String(r["key"])),
    detail: (r["signature"] as string | null) ?? "",
    where: r["file"] ? `${r["file"]}:${r["line"] ?? "?"}` : "",
  }));
}

function gapsFor(store: FactStore, nodeId: number): PackedItem[] {
  return (store.raw().prepare(
    `SELECT u.kind, u.target_hint, u.reason, f.path AS file, u.line
       FROM unresolved_calls u
       LEFT JOIN files f ON f.id = u.file_id
      WHERE u.src_node_id = ?
      ORDER BY u.line`,
  ).all(nodeId) as Array<Record<string, string | number | null>>).map((r) => ({
    tier: "gaps" as const, kind: String(r["kind"]),
    name: (r["target_hint"] as string | null) ?? "(unnamed)",
    detail: String(r["reason"]),
    where: r["file"] ? `${r["file"]}:${r["line"] ?? "?"}` : "",
  }));
}

/** Tier 1's raw source — the seed's own body, and nothing else (R42). */
function readSeedSource(
  store: FactStore, seed: ImpactSeed, roots?: Map<string, string>,
): string | null {
  if (!seed.file) return null;
  const row = store.raw().prepare(
    `SELECT s.start_line, s.end_line, r.root_path
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       JOIN repos r ON r.id = f.repo_id
      WHERE s.node_id = ?`,
  ).get(seed.nodeId) as
    { start_line: number | null; end_line: number | null; root_path: string } | undefined;
  if (!row) return null;

  const root = roots?.get(seed.key.split(" ")[2] ?? "") ?? row.root_path;
  try {
    const lines = readFileSync(join(root, seed.file), "utf8").split(/\r?\n/);
    const from = Math.max(0, (row.start_line ?? 1) - 1);
    const to = Math.min(lines.length, row.end_line ?? from + 1);
    return lines.slice(from, to).join("\n");
  } catch {
    // A missing file is a gap, not a crash: the pack is still useful without
    // tier 1's body, and `source: null` says which.
    return null;
  }
}

// ---------------------------------------------------------------------------
// R44 output
// ---------------------------------------------------------------------------

export function packToToon(pack: ContextPack): string {
  const grouped: Record<string, unknown> = {
    seed: pack.seed.name,
    key: pack.seed.key,
    file: pack.seed.file ?? "",
    budget: pack.budget,
    used: pack.usedTokens,
  };
  for (const tier of TIERS) {
    if (tier === "seed") continue;
    const items = pack.items.filter((i) => i.tier === tier);
    if (items.length > 0) {
      grouped[tier] = items.map((i) => ({
        name: i.name, detail: i.detail, where: i.where,
      }));
    }
  }
  if (pack.droppedTiers.length > 0) grouped["droppedForBudget"] = pack.droppedTiers;
  const head = encodeToon(grouped);
  return pack.source ? `${head}\n\nsource:\n${pack.source}\n` : `${head}\n`;
}

/**
 * R71's measurement: the pack against dumping every file it touches.
 *
 * The comparison has to be against something a person would otherwise actually
 * do. "Dump the files containing everything on this pack" is that: it is what
 * an agent does when it has no graph, and it is the baseline the ratio has to
 * beat to justify the engine.
 */
export interface TokenDelta {
  packTokens: number;
  dumpTokens: number;
  files: number;
  ratio: number;
}

export function measureTokenDelta(
  store: FactStore, pack: ContextPack,
): TokenDelta {
  const paths = new Set<string>();
  if (pack.seed.file) paths.add(pack.seed.file);
  for (const item of pack.items) {
    const file = item.where.split(":")[0];
    if (file && file.includes(".")) paths.add(file);
  }

  let dumpChars = 0;
  let files = 0;
  const rootOf = store.raw().prepare(
    `SELECT r.root_path FROM files f JOIN repos r ON r.id = f.repo_id
      WHERE f.path = ? LIMIT 1`,
  );
  for (const path of paths) {
    const row = rootOf.get(path) as { root_path: string } | undefined;
    if (!row) continue;
    try {
      dumpChars += readFileSync(join(row.root_path, path), "utf8").length;
      files += 1;
    } catch { /* a file that cannot be read is not part of the baseline */ }
  }

  const packTokens = estimateTokens(packToToon(pack));
  const dumpTokens = estimateTokens("x".repeat(dumpChars));
  return {
    packTokens,
    dumpTokens,
    files,
    ratio: dumpTokens === 0 ? 0 : packTokens / dumpTokens,
  };
}
