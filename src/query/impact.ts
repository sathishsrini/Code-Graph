// ============================================================================
// impact  —  task P1-T13  (requirements R37, R38, R39)
// ============================================================================
// "What does this change break?" — the reverse of endpoint_flow, projected
// onto routes.
//
// The traversal is the easy half. The hard half is not drowning the reader,
// and the doc is explicit about how this feature dies: a utility function has
// 200 callers, the honest answer is "everything", and an answer of
// "everything" is indistinguishable from no answer at all. So R39 is not a
// nicety — computing fan-in and SAYING "this is a utility, expect broad
// impact" is what keeps the other 95% of queries useful.
//
// Three segmentations, none of which may be merged:
//
//   direct vs transitive   R37. A depth-1 caller is a different fact from a
//                          depth-6 one, and averaging them is how "this change
//                          is risky" stops meaning anything.
//
//   by confidence          CERTAIN / INFERRED / UNKNOWN. A path crossing one
//                          inferred hop is not evidence the change breaks that
//                          route — it is evidence it MIGHT.
//
//   by dependency kind     R38. `direct` and `indirect` come from the call
//                          graph; `configuration` and `data` come from shared
//                          nodes and are genuinely different relationships
//                          that no call graph can see.
//
// R38's fifth kind, `runtime` (trace co-occurrence), has no producer until
// P2-T8 ships the OTLP receiver. It is reported as absent-by-construction
// rather than omitted, because "no runtime evidence" and "we did not look" are
// different answers and only one of them is about the code.
// ============================================================================

import type { Confidence, FactStore } from "../store/db.ts";
import { displayNameOf } from "../static/scip/symbol.ts";

/**
 * Reverse-traversed edge types.
 *
 * `HANDLES` and `REQUESTS` are what make this cross-service without a special
 * case: a route HANDLES its chain symbols, and a caller in another service
 * REQUESTS that route, so reversing both walks from a symbol out through its
 * own routes and on into every service that calls them.
 */
const REVERSED = ["CALLS", "HANDLES", "REQUESTS"] as const;

/**
 * Distinct callers above which a symbol is a utility rather than a dependency.
 *
 * Not tuned — declared. On this corpus `nowIso` has 8 and `envelopeError` 7,
 * so 10 keeps them below the line while `console.log`-shaped helpers in a real
 * repo land well above it. The number is an option because the right value is
 * a property of the codebase, and a threshold nobody can change is a threshold
 * nobody trusts.
 */
const DEFAULT_UTILITY_FAN_IN = 10;

/** Routes listed before the list itself becomes the problem (R39). */
const DEFAULT_ROUTE_LIMIT = 25;

export type DependencyKind = "direct" | "indirect" | "configuration" | "data" | "runtime";

export interface AffectedSymbol {
  nodeId: number;
  key: string;
  display: string;
  /** 1 = calls the seed directly. */
  depth: number;
  pathConfidence: Confidence;
  file: string | null;
  line: number | null;
}

export interface AffectedRoute {
  nodeId: number;
  key: string;
  service: string;
  method: string;
  url: string;
  /** Shortest hop count from the seed to a symbol this route runs. */
  depth: number;
  pathConfidence: Confidence;
  /** How the route was reached: which symbol on its chain is affected. */
  viaSymbol: string;
}

export interface SharedNode {
  nodeId: number;
  kind: string;
  key: string;
  /**
   * Which node's edge found this: the seed symbol, or the file that owns it.
   *
   * The distinction is the whole honesty of the section. Every config read and
   * every SQL literal in this corpus sits at module scope or inside an
   * anonymous handler, so `ownerSymbol` attributes them to the FILE rather
   * than guessing a function. Reporting those as the symbol's own dependencies
   * would be a claim the source does not support; reporting nothing would hide
   * a real coupling. So they are reported, and labelled.
   */
  attributedTo: "symbol" | "file";
  /** Other symbols or files touching the same node. */
  alsoUsedBy: Array<{ key: string; display: string; service: string | null; type: string }>;
}

export interface ImpactSeed {
  nodeId: number;
  kind: string;
  key: string;
  display: string;
  file: string | null;
  /** `file` node owning this symbol, for R38's file-attributed dependencies. */
  fileNodeId: number | null;
}

export interface ImpactReport {
  seed: ImpactSeed;
  /** Distinct direct callers. The R39 signal. */
  fanIn: number;
  /** True when fan-in says "expect broad impact" rather than a useful list. */
  isUtility: boolean;
  utilityThreshold: number;
  /** Depth-1 callers, reported separately from the rest (R37). */
  direct: AffectedSymbol[];
  transitive: AffectedSymbol[];
  /** Routes, segmented by the weakest edge on the path that reached them. */
  routes: Record<"certain" | "inferred" | "unknown", AffectedRoute[]>;
  /** True when the route list was cut. The count is still exact. */
  routesTruncated: boolean;
  totalRoutes: number;
  /** R38 configuration dependency: other readers of config this seed reads. */
  configuration: SharedNode[];
  /** R38 data dependency: other users of a datastore this seed touches. */
  data: SharedNode[];
  /**
   * R38 runtime dependency. Always empty until P2-T8; `available` says which
   * of "no evidence" and "no producer" is true.
   */
  runtime: { available: boolean; reason: string; routes: AffectedRoute[] };
  /** Gaps owned by any symbol in the closure — the change may reach further. */
  unknownEdges: Array<{ srcKey: string; reason: string; file: string | null; line: number | null }>;
}

export interface ImpactOptions {
  maxDepth?: number;
  utilityFanIn?: number;
  routeLimit?: number;
}

export class SeedNotFound extends Error {
  readonly matches: Array<{ key: string; display: string }>;

  constructor(query: string, matches: Array<{ key: string; display: string }>) {
    super(
      matches.length === 0
        ? `no symbol matching "${query}" in the store`
        : `"${query}" is ambiguous — ${matches.length} symbols match`,
    );
    this.name = "SeedNotFound";
    this.matches = matches;
  }
}

// ---------------------------------------------------------------------------

/**
 * Resolve a human-typed seed to one node.
 *
 * Accepts a verbatim SCIP symbol (what a tool passes) or a bare display name
 * (what a person types). An ambiguous name raises rather than picking one —
 * silently choosing between two `handler` symbols would answer a question
 * about the wrong function, and nothing in the output would say so.
 */
export function resolveSeed(store: FactStore, query: string): ImpactSeed {
  const db = store.raw();

  const build = (
    row: { id: number; kind: string; key: string; file: string | null },
  ): ImpactSeed => ({
    nodeId: row.id,
    kind: row.kind,
    key: row.key,
    display: row.kind === "symbol" ? displayNameOf(row.key) : row.key,
    file: row.file,
    // A symbol's owning file. Config reads and SQL literals attribute to the
    // file when no non-namespace definition contains them, so without this the
    // configuration and data sections are empty for every symbol seed.
    fileNodeId: row.kind === "file"
      ? row.id
      : fileNodeFor(store, row.file),
  });

  // 1. A verbatim node key — a SCIP symbol, a route key, `env:X`, a file key.
  const exact = db.prepare(
    `SELECT n.id, n.kind, n.key, f.path AS file
       FROM nodes n
       LEFT JOIN symbols s ON s.node_id = n.id
       LEFT JOIN files f ON f.id = s.file_id
      WHERE n.key = ?`,
  ).get(query) as { id: number; kind: string; key: string; file: string | null } | undefined;
  if (exact) return build(exact);

  // 2. A file, by repo-relative path or by its `<repo>/<path>` node key. The
  //    corpus attributes every datastore and config edge to a file, so asking
  //    about one is the only way to reach R38's data dependency here.
  const asFile = db.prepare(
    `SELECT n.id, n.kind, n.key, ? AS file
       FROM nodes n
      WHERE n.kind = 'file' AND (n.key = ? OR n.key LIKE '%/' || ?)
      ORDER BY LENGTH(n.key)`,
  ).all(query, query, query) as
    Array<{ id: number; kind: string; key: string; file: string | null }>;
  if (asFile.length === 1) return build(asFile[0]!);
  if (asFile.length > 1) {
    throw new SeedNotFound(query, asFile.map((f) => ({ key: f.key, display: f.key })));
  }

  // 3. A bare display name.
  const candidates = db.prepare(
    `SELECT n.id, n.kind, n.key, f.path AS file
       FROM nodes n
       JOIN symbols s ON s.node_id = n.id
       LEFT JOIN files f ON f.id = s.file_id
      WHERE s.display_name = ?
      ORDER BY n.key`,
  ).all(query) as Array<{ id: number; kind: string; key: string; file: string | null }>;

  if (candidates.length === 1) return build(candidates[0]!);

  throw new SeedNotFound(query, candidates.map((c) => ({
    key: c.key, display: displayNameOf(c.key),
  })));
}

/** The `file` node whose key ends in this repo-relative path. */
function fileNodeFor(store: FactStore, path: string | null): number | null {
  if (!path) return null;
  const row = store.raw().prepare(
    "SELECT id FROM nodes WHERE kind = 'file' AND key LIKE '%/' || ? ORDER BY LENGTH(key) LIMIT 1",
  ).get(path) as { id: number } | undefined;
  return row?.id ?? null;
}

export function impact(
  store: FactStore, query: string, options: ImpactOptions = {},
): ImpactReport {
  const db = store.raw();
  const maxDepth = options.maxDepth ?? 12;
  const utilityFanIn = options.utilityFanIn ?? DEFAULT_UTILITY_FAN_IN;
  const routeLimit = options.routeLimit ?? DEFAULT_ROUTE_LIMIT;

  const seed = resolveSeed(store, query);

  const fanIn = (db.prepare(
    `SELECT COUNT(DISTINCT src_node_id) AS n FROM edges
      WHERE dst_node_id = ? AND type = 'CALLS'`,
  ).get(seed.nodeId) as { n: number }).n;

  const closure = reverseClosure(store, seed.nodeId, maxDepth);

  // --- symbols, split at depth 1 (R37) ------------------------------------
  const direct: AffectedSymbol[] = [];
  const transitive: AffectedSymbol[] = [];
  for (const row of closure) {
    if (row.kind !== "symbol") continue;
    const entry: AffectedSymbol = {
      nodeId: row.node_id, key: row.key, display: displayNameOf(row.key),
      depth: row.depth, pathConfidence: row.path_conf as Confidence,
      file: row.file_path, line: row.line,
    };
    if (row.depth === 1) direct.push(entry); else transitive.push(entry);
  }

  // --- routes, segmented by path confidence -------------------------------
  const routes: ImpactReport["routes"] = { certain: [], inferred: [], unknown: [] };
  const seenRoute = new Map<number, AffectedRoute>();
  for (const row of closure) {
    if (row.kind !== "route") continue;
    const existing = seenRoute.get(row.node_id);
    // Keep the SHORTEST path to each route: a route reached at depth 2 and
    // again at depth 7 is a depth-2 dependency, and reporting the longer one
    // understates it.
    if (existing && existing.depth <= row.depth) continue;
    const parts = row.key.split(" ");
    seenRoute.set(row.node_id, {
      nodeId: row.node_id, key: row.key,
      service: parts[0] ?? "", method: parts[1] ?? "", url: parts.slice(2).join(" "),
      depth: row.depth, pathConfidence: row.path_conf as Confidence,
      viaSymbol: displayNameOf(row.via_key ?? ""),
    });
  }
  // Routes whose CHAIN names the seed. This is what makes the module-scope
  // stop safe: `POST /api/v1/mail/send` runs `checkUserAuth` inside an
  // anonymous handler, so the call graph attributes it to the module and the
  // closure stops there — but `route_chain` names the check exactly, at the
  // right route and nowhere else.
  //
  // Merged BEFORE bucketing. Adding it after left the route counted in
  // `totalRoutes` and missing from every confidence bucket, so the sections
  // summed to one less than the total (self-review, 2026-09-08).
  for (const named of routesNamingSeed(store, seed)) {
    const existing = seenRoute.get(named.nodeId);
    if (existing && !isBetterEvidence(named, existing)) continue;
    seenRoute.set(named.nodeId, named);
  }

  for (const route of [...seenRoute.values()].sort(byDepthThenKey)) {
    const bucket = route.pathConfidence === "certain" ? "certain"
      : route.pathConfidence === "unresolved" ? "unknown" : "inferred";
    routes[bucket].push(route);
  }

  const totalRoutes = seenRoute.size;
  let routesTruncated = false;
  if (totalRoutes > routeLimit) {
    // R39: cut the LIST, never the count. "affects 200 routes, 25 shown" is a
    // usable answer; 200 lines is the same information rendered as noise.
    routesTruncated = true;
    for (const key of ["certain", "inferred", "unknown"] as const) {
      const share = Math.max(1, Math.round(routeLimit * (routes[key].length / totalRoutes)));
      routes[key] = routes[key].slice(0, share);
    }
  }

  const closureIds = new Set(closure.filter((r) => r.kind === "symbol").map((r) => r.node_id));
  closureIds.add(seed.nodeId);

  return {
    seed,
    fanIn,
    isUtility: fanIn >= utilityFanIn,
    utilityThreshold: utilityFanIn,
    direct: direct.sort(byDepthThenKey),
    transitive: transitive.sort(byDepthThenKey),
    routes,
    routesTruncated,
    totalRoutes,
    configuration: sharedNodes(store, seed, "config", ["READS_CONFIG"]),
    data: sharedNodes(store, seed, "datastore", ["READS", "WRITES"]),
    runtime: {
      available: false,
      // Stated, not omitted. An empty section with no explanation reads as
      // "nothing observed", which is a claim about the system; the truth is a
      // claim about the engine.
      reason: "no `spans` table — the OTel receiver is P2-T8. This is 'no producer', not 'no traffic'.",
      routes: [],
    },
    unknownEdges: gapsIn(store, closureIds),
  };
}

/**
 * Routes that name the seed on their chain, from either security channel.
 *
 * Depth 1: the route runs this symbol, with nothing in between. Confidence
 * comes from the row — a boot hook is `certain`, an inline check is
 * `inferred` — so a statically-detected check never reports as a fact.
 */
function routesNamingSeed(store: FactStore, seed: ImpactSeed): AffectedRoute[] {
  const rows = store.raw().prepare(
    `SELECT n.id AS node_id, n.key, r.service_name, r.method, r.url,
            rc.confidence, rc.phase, rc.name
       FROM route_chain rc
       JOIN routes r ON r.node_id = rc.route_node_id
       JOIN nodes n ON n.id = rc.route_node_id
      WHERE rc.symbol_node_id = ? OR (rc.name = ? AND rc.name IS NOT NULL)
      ORDER BY r.service_name, r.url, r.method`,
  ).all(seed.nodeId, seed.display) as Array<Record<string, string | number | null>>;

  return rows.map((r) => ({
    nodeId: Number(r["node_id"]),
    key: String(r["key"]),
    service: String(r["service_name"]),
    method: String(r["method"]),
    url: String(r["url"]),
    depth: 1,
    pathConfidence: String(r["confidence"]) as Confidence,
    viaSymbol: `${r["phase"]} ${r["name"] ?? seed.display}`,
  }));
}

const CONF_RANK: Record<string, number> = {
  certain: 3, observed: 2, inferred: 1, unresolved: 0,
};

/**
 * Which of two ways of reaching a route is the better evidence.
 *
 * **Confidence first, depth second.** Ranking by depth alone got this
 * backwards: `POST /api/v1/po` is reached at depth 2 through a `certain` call
 * chain (`proxyToEngine` -> `checkUserAuth`) *and* at depth 1 through an
 * `inferred` inline-check row. Preferring the shorter path relabelled all 15
 * compiler-resolved routes as inferred, which understates what is actually
 * known — the mirror of the overstating this file's other rules guard against
 * (self-review, 2026-09-08).
 */
function isBetterEvidence(
  candidate: AffectedRoute, existing: AffectedRoute,
): boolean {
  const a = CONF_RANK[candidate.pathConfidence] ?? 0;
  const b = CONF_RANK[existing.pathConfidence] ?? 0;
  if (a !== b) return a > b;
  return candidate.depth < existing.depth;
}

function byDepthThenKey(
  a: { depth: number; key: string }, b: { depth: number; key: string },
): number {
  return a.depth - b.depth || a.key.localeCompare(b.key);
}

// ---------------------------------------------------------------------------

interface ClosureRow {
  node_id: number;
  kind: string;
  key: string;
  depth: number;
  path_conf: string;
  file_path: string | null;
  line: number | null;
  via_key: string | null;
}

/**
 * Everything that reaches `seedId`, with the weakest edge on each path.
 *
 * The mirror of endpoint_flow's CTE, walking `idx_edges_in` instead. Two
 * asymmetries, both load-bearing:
 *
 * 1. It expands out of `route` nodes, because a route reached from a symbol is
 *    not a terminal here — another service's REQUESTS edge points at it, and
 *    stopping would hide every cross-service consumer.
 *
 * 2. It refuses to expand out of a **namespace** symbol (a module). A call
 *    made inside an anonymous handler has no definition of its own, so SCIP
 *    attributes it to the module — and the module is HANDLED by every route in
 *    the file. Traversing through it made `checkUserAuth` report `/health`,
 *    `/ready` and `POST /api/v1/auth/login` as affected, none of which call it.
 *    That is a confident wrong answer, the exact class this project exists to
 *    stop, so the module is reported as an affected symbol and the walk stops.
 *    Routes that genuinely run the seed are recovered precisely from
 *    `route_chain` instead — see `routesNamingSeed`.
 */
function reverseClosure(store: FactStore, seedId: number, maxDepth: number): ClosureRow[] {
  const types = REVERSED.map(() => "?").join(", ");
  return store.raw().prepare(
    `WITH RECURSIVE back(node_id, depth, path_conf, path, via) AS (
       SELECT ?, 0, 'certain', '/' || ? || '/', NULL
       UNION ALL
       SELECT e.src_node_id,
              b.depth + 1,
              CASE
                WHEN b.path_conf = 'unresolved' OR e.confidence = 'unresolved' THEN 'unresolved'
                WHEN b.path_conf = 'inferred'   OR e.confidence = 'inferred'   THEN 'inferred'
                WHEN b.path_conf = 'observed'   OR e.confidence = 'observed'   THEN 'observed'
                ELSE 'certain'
              END,
              b.path || e.src_node_id || '#' || e.id || '/',
              b.node_id
         FROM back b
         JOIN nodes bn ON bn.id = b.node_id
         LEFT JOIN symbols bs ON bs.node_id = b.node_id
         JOIN edges e ON e.dst_node_id = b.node_id
        WHERE b.depth < ?
          AND (b.depth = 0 OR bn.kind <> 'symbol'
               OR bs.symbol_kind IS NULL OR bs.symbol_kind <> 'namespace')
          AND instr(b.path, '/' || e.src_node_id || '#') = 0
          AND e.type IN (${types})
     )
     SELECT b.node_id, n.kind, n.key, MIN(b.depth) AS depth, b.path_conf,
            f.path AS file_path, s.start_line AS line, vn.key AS via_key
       FROM back b
       JOIN nodes n ON n.id = b.node_id
       LEFT JOIN symbols s ON s.node_id = b.node_id
       LEFT JOIN files f ON f.id = s.file_id
       LEFT JOIN nodes vn ON vn.id = b.via
      WHERE b.depth > 0
      GROUP BY b.node_id
      ORDER BY depth, n.key`,
  ).all(seedId, seedId, maxDepth, ...REVERSED) as unknown as ClosureRow[];
}

/**
 * R38's configuration and data dependencies.
 *
 * Neither is a call. Two services reading `DATABASE_URL`, or writing
 * `mail_events`, are coupled through a node they share — and OPEN-9's decision
 * was to leave that implicit and make it a query rather than storing a
 * service-to-service edge that duplicates the join.
 *
 * This is that query.
 */
function sharedNodes(
  store: FactStore, seed: ImpactSeed, kind: string, types: string[],
): SharedNode[] {
  const q = types.map(() => "?").join(", ");
  const sources: Array<{ id: number; via: "symbol" | "file" }> = [
    { id: seed.nodeId, via: "symbol" },
  ];
  // The file that owns the seed, when it has one. See `SharedNode.attributedTo`.
  const fileNode = seed.fileNodeId;
  if (fileNode !== null && fileNode !== seed.nodeId) {
    sources.push({ id: fileNode, via: "file" });
  }

  const touchQuery = store.raw().prepare(
    `SELECT DISTINCT n.id, n.kind, n.key
       FROM edges e JOIN nodes n ON n.id = e.dst_node_id
      WHERE e.src_node_id = ? AND n.kind = ? AND e.type IN (${q})
      ORDER BY n.key`,
  );

  const touched: Array<{ id: number; kind: string; key: string; via: "symbol" | "file" }> = [];
  const seen = new Set<number>();
  for (const src of sources) {
    for (const row of touchQuery.all(src.id, kind, ...types) as
      Array<{ id: number; kind: string; key: string }>) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      touched.push({ ...row, via: src.via });
    }
  }

  const others = store.raw().prepare(
    `SELECT DISTINCT n.key, e.type, r.service_name
       FROM edges e
       JOIN nodes n ON n.id = e.src_node_id
       LEFT JOIN repos r ON r.id = n.repo_id
      WHERE e.dst_node_id = ? AND e.src_node_id <> ?
      ORDER BY n.key`,
  );

  return touched.map((t) => ({
    nodeId: t.id, kind: t.kind, key: t.key, attributedTo: t.via,
    alsoUsedBy: (others.all(t.id, seed.nodeId) as Array<{
      key: string; type: string; service_name: string | null;
    }>).map((o) => ({
      key: o.key, display: displayNameOf(o.key),
      service: o.service_name, type: o.type,
    })),
  }));
}

/** `unresolved_calls` owned by anything in the closure — the change may reach further. */
function gapsIn(
  store: FactStore, ids: Set<number>,
): ImpactReport["unknownEdges"] {
  if (ids.size === 0) return [];
  const list = [...ids];
  const q = list.map(() => "?").join(", ");
  const rows = store.raw().prepare(
    `SELECT n.key AS src_key, u.reason, f.path AS file_path, u.line
       FROM unresolved_calls u
       JOIN nodes n ON n.id = u.src_node_id
       LEFT JOIN files f ON f.id = u.file_id
      WHERE u.src_node_id IN (${q})
      ORDER BY f.path, u.line`,
  ).all(...list) as Array<Record<string, string | number | null>>;

  return rows.map((r) => ({
    srcKey: displayNameOf(String(r["src_key"])),
    reason: String(r["reason"]),
    file: (r["file_path"] as string | null) ?? null,
    line: r["line"] === null ? null : Number(r["line"]),
  }));
}
