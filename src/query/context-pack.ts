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
import { weakest } from "./flow.ts";
import { inHandlerRange, scopedSitesInto } from "../derive/handler-scope.ts";

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
  /** CTX-S7: exact line ranges to Read before editing. Never dropped for budget. */
  readRanges: ReadRange[];
  /** CTX-S7: seed, callees or callers with no usable stored range, and why. */
  readRangeGaps: ReadRangeGap[];
}

/** CTX-S7: one Read call's worth of lines. */
export interface ReadRange {
  /** Absolute: the repo's `root_path` joined to `files.path`. Read takes absolute paths. */
  file: string;
  /** 1-based and inclusive, verbatim from `symbols.start_line` / `end_line`. */
  start: number;
  end: number;
  /** `role:name` per symbol covered. More than one only where ranges overlapped or touched. */
  symbols: string[];
}

/** CTX-S7: a symbol the pack cannot hand over as a range. Never filled with a guess. */
export interface ReadRangeGap {
  /** `role:name`, as in `ReadRange.symbols`. */
  symbol: string;
  /** Absolute path, or "" when no file is stored. */
  file: string;
  /** The start line; for a module-scope caller, its call sites; empty when unknown. */
  lines: number[];
  reason: string;
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
  // CTX-S10a: `neighbours` leaves module callers out; they come back credited
  // to the route whose anonymous handler holds the call, or labelled file-scope.
  put("callers", [...neighbours(store, seed.nodeId, "in"), ...moduleScopeCallers(store, seed.nodeId)]);
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

  // CTX-S7: computed outside the tier walk, so no budget can drop them.
  const reads = readRangesFor(store, seed.nodeId, options.repoRoots);

  return {
    seed: { name: seed.display, key: seed.key, file: seed.file, signature },
    source,
    items,
    budget,
    usedTokens: used,
    includedTiers: included,
    droppedTiers: dropped,
    readRanges: reads.ranges,
    readRangeGaps: reads.gaps,
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
        ${dir === "in" ? "AND COALESCE(s.symbol_kind, '') <> 'namespace'" : ""}
      ORDER BY n.key`,
  ).all(nodeId) as Array<Record<string, string | number | null>>).map((r) => ({
    tier: dir === "out" ? "callees" as const : "callers" as const,
    kind: String(r["kind"]),
    name: String(r["kind"]) === "symbol" ? displayNameOf(String(r["key"])) : String(r["key"]),
    detail: `${r["type"]} [${r["confidence"]}]${r["signature"] ? ` ${r["signature"]}` : ""}`,
    where: r["file"] ? `${r["file"]}:${r["line"] ?? "?"}` : "",
  }));
}

/**
 * Module-scope callers of the seed (CTX-S10a).
 *
 * A call inside an anonymous handler attributes to the module; the route
 * whose boot-located handler range holds it is the caller a reader needs,
 * listed at the call's file:line. A call outside every range stays the
 * module's, and says so. One item per caller, its call lines joined.
 */
function moduleScopeCallers(store: FactStore, nodeId: number): PackedItem[] {
  const byCaller = new Map<string, {
    kind: string; name: string; detail: string; file: string; scope: string; lines: Set<number>;
  }>();
  for (const site of scopedSitesInto(store, [nodeId], ["CALLS", "CALLS_EXTERNAL"])) {
    for (const route of site.routes.length > 0 ? site.routes : [null]) {
      const confidence = route ? weakest(site.confidence, route.rangeConfidence) : site.confidence;
      const id = `${route?.routeKey ?? site.srcKey}|${site.type}|${confidence}|${site.file}`;
      const entry = byCaller.get(id) ?? {
        kind: route ? "route" : "symbol",
        name: route ? `${route.method} ${route.url}` : displayNameOf(site.srcKey),
        detail: `${site.type} [${confidence}]${route ? " anonymous handler" : ""}`,
        file: site.file ?? "?",
        scope: route ? "" : " [file-scope]",
        lines: new Set<number>(),
      };
      entry.lines.add(site.line);
      byCaller.set(id, entry);
    }
  }
  return [...byCaller.values()]
    .map((c): PackedItem => ({
      tier: "callers", kind: c.kind, name: c.name, detail: c.detail,
      where: `${c.file}:${[...c.lines].sort((a, b) => a - b).join(",")}${c.scope}`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A route that runs the seed from inside its anonymous handler (CTX-S10a).
 * Replaces the HANDLES -> module -> CALLS bridge, which put every route whose
 * chain touches the module (an anonymous hook suffices) on the seed — the
 * defect `impact` stopped on 2026-09-08. Binds the seed once.
 */
const RUNS_IN_ANONYMOUS_HANDLER = `
  SELECT rc.route_node_id FROM route_chain rc
    JOIN edges e ON ${inHandlerRange("e", "rc")}
    JOIN symbols es ON es.node_id = e.src_node_id AND es.symbol_kind = 'namespace'
   WHERE e.type = 'CALLS' AND e.dst_node_id = ?`;

/** SQL: `h.dst_node_id` is not a module, so a HANDLES -> CALLS hop is a real one. */
const NOT_VIA_MODULE = `NOT EXISTS (
  SELECT 1 FROM symbols hs WHERE hs.node_id = h.dst_node_id AND hs.symbol_kind = 'namespace')`;

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
                 AND c.type = 'CALLS' AND c.dst_node_id = ? AND ${NOT_VIA_MODULE})
         OR r.node_id IN (${RUNS_IN_ANONYMOUS_HANDLER})
      ORDER BY r.service_name, r.url, r.method`,
  ).all(nodeId, nodeId, nodeId) as Array<{ service_name: string; method: string; url: string }>)
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
               WHERE h.type = 'HANDLES' AND c.type = 'CALLS' AND c.dst_node_id = ?
                 AND ${NOT_VIA_MODULE}
              UNION
              ${RUNS_IN_ANONYMOUS_HANDLER})
      ORDER BY r.url, rc.position`,
  ).all(nodeId, nodeId, nodeId) as Array<Record<string, string | null>>).map((r) => ({
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

  // CTX-S10a: a file-node edge inside an anonymous handler's range belongs to
  // that route, not to the file, so it is no longer this seed's file scope.
  return (store.raw().prepare(
    `SELECT DISTINCT n.key, e.type, e.src_node_id
       FROM edges e JOIN nodes n ON n.id = e.dst_node_id
      WHERE e.src_node_id IN (${placeholders}) AND n.kind = ? AND e.type IN (${q})
        AND (e.src_node_id = ?
             OR NOT EXISTS (SELECT 1 FROM route_chain rc WHERE ${inHandlerRange("e", "rc")}))
      ORDER BY n.key`,
  ).all(...sources, kind, ...types, seed.nodeId) as Array<Record<string, string | number>>).map((r) => ({
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
// Read ranges  —  slice CTX-S7
// ---------------------------------------------------------------------------
// Claude Code's edit tool refuses a file that was not Read first, and Read
// takes offset/limit. With start lines only, the reader Read whole files to
// find where each function ends. These are the exact `symbols` ranges for the
// seed and its direct CALLS neighbours, both directions.
//
// Decisions, each a place where a range could quietly mislead:
//
// - **Outside the budget.** A few tokens a row, and the point of the pack; a
//   budget that dropped them would send the reader back to whole files.
// - **Absolute paths**, `repos.root_path` + `files.path`, because that is what
//   Read takes. `repoRoots` overrides a root, as it does for tier 1.
// - **Merged only when they overlap or touch** in one file: a function nested
//   in its caller, or adjacent definitions. That removes duplicate lines for
//   free. Across even a one-line gap they stay apart, since merging there
//   reads lines nobody asked for to save one call.
// - **No end line, no range.** The symbol becomes a gap carrying its start
//   line. An end is never invented.
// - **A module-scope neighbour is a gap at its call lines.** SCIP credits a
//   call inside an anonymous handler to the module, whose stored range is the
//   whole file, which is the read this slice exists to avoid.
// - **CALLS_EXTERNAL targets are left out.** They live outside the indexed
//   repos, so no range is expected and none is missing.
// ---------------------------------------------------------------------------

interface RangeRow {
  id: number; kind: string; key: string; symbol_kind: string | null;
  start_line: number | null; end_line: number | null;
  path: string | null; repo: string | null; root_path: string | null;
  call_line: number | null;
}

function readRangesFor(
  store: FactStore, seedId: number, roots?: Map<string, string>,
): { ranges: ReadRange[]; gaps: ReadRangeGap[] } {
  const db = store.raw();
  const cols = `n.id, n.kind, n.key, s.symbol_kind, s.start_line, s.end_line,
                f.path, r.name AS repo, r.root_path`;
  const joins = `LEFT JOIN symbols s ON s.node_id = n.id
                 LEFT JOIN files f ON f.id = s.file_id
                 LEFT JOIN repos r ON r.id = f.repo_id`;

  const rows: Array<[string, RangeRow]> = [];
  const seedRow = db.prepare(
    `SELECT ${cols}, NULL AS call_line FROM nodes n ${joins} WHERE n.id = ?`,
  ).get(seedId) as RangeRow | undefined;
  if (seedRow) rows.push(["seed", seedRow]);
  for (const [role, self, other] of [
    ["callee", "src_node_id", "dst_node_id"],
    ["caller", "dst_node_id", "src_node_id"],
  ] as const) {
    const found = db.prepare(
      `SELECT ${cols}, e.line AS call_line
         FROM edges e JOIN nodes n ON n.id = e.${other} ${joins}
        WHERE e.${self} = ? AND e.type = 'CALLS' AND n.id <> ?
        ORDER BY n.key, e.line`,
    ).all(seedId, seedId) as unknown as RangeRow[];
    for (const row of found) rows.push([role, row]);
  }

  // One entry per role and node; a node with several call sites keeps them all.
  const byNode = new Map<string, { role: string; row: RangeRow; calls: number[] }>();
  for (const [role, row] of rows) {
    const entry = byNode.get(`${role} ${row.id}`) ??
      { role, row, calls: [] as number[] };
    byNode.set(`${role} ${row.id}`, entry);
    if (row.call_line !== null && !entry.calls.includes(row.call_line)) {
      entry.calls.push(row.call_line);
    }
  }

  const ranges: ReadRange[] = [];
  const gaps: ReadRangeGap[] = [];
  for (const { role, row, calls } of byNode.values()) {
    const symbol = `${role}:${row.kind === "symbol" ? displayNameOf(row.key) : row.key}`;
    const root = row.repo === null ? null : roots?.get(row.repo) ?? row.root_path;
    const file = row.path === null || root === null ? "" : join(root, row.path);
    const gap = (lines: number[], reason: string) =>
      gaps.push({ symbol, file, lines, reason });

    if (file === "" || row.start_line === null) gap([], "no stored file or start line");
    else if (row.symbol_kind === "namespace") {
      gap(calls.length > 0 ? calls : [row.start_line], "module scope: its stored range is the whole file");
    } else if (row.end_line === null) gap([row.start_line], "no end line stored; the end is unknown");
    else if (row.end_line < row.start_line) gap([row.start_line], "stored end line precedes the start");
    else ranges.push({ file, start: row.start_line, end: row.end_line, symbols: [symbol] });
  }
  return { ranges: mergeRanges(ranges), gaps };
}

/** Sort by file and start; merge ranges that overlap or touch. Nothing else. */
function mergeRanges(ranges: ReadRange[]): ReadRange[] {
  const sorted = [...ranges].sort((a, b) =>
    a.file === b.file ? a.start - b.start || a.end - b.end : a.file < b.file ? -1 : 1);
  const out: ReadRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && last.file === r.file && r.start <= last.end + 1) {
      last.end = Math.max(last.end, r.end);
      last.symbols.push(...r.symbols.filter((s) => !last.symbols.includes(s)));
    } else {
      out.push({ ...r, symbols: [...r.symbols] });
    }
  }
  return out;
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
  // CTX-S7: the Read plan, first after the header because it is what the
  // reader acts on. Rendered even when empty; the gaps say why.
  grouped["readRanges"] = pack.readRanges.map((r) => ({
    file: r.file, start: r.start, end: r.end, symbols: r.symbols.join("|"),
  }));
  if (pack.readRangeGaps.length > 0) {
    grouped["readRangeGaps"] = pack.readRangeGaps.map((g) => ({
      symbol: g.symbol, file: g.file, line: g.lines.join("|"), reason: g.reason,
    }));
  }
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

/**
 * CTX-S7's measurement: Read(readRanges) against Read(the whole files they
 * sit in), counted as the Read tool returns text: bytes, plus a 7-byte
 * line-number gutter per line (`READ_GUTTER_BYTES`, the convention of
 * scripts/workflow-bench-score.ts). Tokens are bytes / 4. Range gaps are in
 * neither side and are counted, so a reader sees what the numbers leave out.
 */
export interface ReadRangeDelta {
  rangeBytes: number;
  fileBytes: number;
  rangeTokens: number;
  fileTokens: number;
  ranges: number;
  files: number;
  gaps: number;
}

export function measureReadRanges(pack: ContextPack): ReadRangeDelta {
  const GUTTER = 7;
  let rangeBytes = 0;
  let fileBytes = 0;
  const files = new Map<string, Buffer | null>();
  const readOnce = (file: string): Buffer | null => {
    if (!files.has(file)) {
      try { files.set(file, readFileSync(file)); } catch { files.set(file, null); }
    }
    return files.get(file) ?? null;
  };

  for (const r of pack.readRanges) {
    const data = readOnce(r.file);
    if (!data) continue;
    const lines = data.toString("utf8").split("\n").slice(r.start - 1, r.end);
    for (const line of lines) rangeBytes += Buffer.byteLength(line, "utf8") + 1 + GUTTER;
  }
  let readable = 0;
  for (const data of files.values()) {
    if (!data) continue;
    readable += 1;
    let newlines = 0;
    for (const byte of data) if (byte === 0x0a) newlines += 1;
    fileBytes += data.length + newlines * GUTTER;
  }
  return {
    rangeBytes,
    fileBytes,
    rangeTokens: Math.round(rangeBytes / 4),
    fileTokens: Math.round(fileBytes / 4),
    ranges: pack.readRanges.length,
    files: readable,
    gaps: pack.readRangeGaps.length,
  };
}
