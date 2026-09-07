// ============================================================================
// endpoint_flow  —  task P1-T12  (requirements R35, R36)
// ============================================================================
// "What executes on this endpoint?" — answered from the store rather than from
// artifacts, so it works across every indexed service at once. The Phase 0
// `flow` in ./flow.ts reads a .scip file and a boot dump directly and stops at
// one service; this reads `route_chain` and `edges` and crosses boundaries.
//
// Four things R35 asks for that are easy to get subtly wrong, and how each is
// handled here:
//
//   depth cap + cycle guard   The recursive CTE carries the ancestor path as a
//                             string and refuses a node already on it. A cycle
//                             is marked, not silently pruned — "we stopped
//                             here" and "there is nothing here" are different
//                             claims.
//
//   boundary termination      The walk expands only out of `symbol` nodes.
//                             external / datastore / config are terminals by
//                             kind, so no per-package special case is needed.
//
//   cross-service recursion   A REQUESTS edge lands on a `route` node in
//                             another service. That route's own chain is then
//                             expanded, guarded by a visited-route set so two
//                             services calling each other terminate.
//
//   min_conf propagation      R36: a path is only as trustworthy as its
//                             weakest edge, computed IN the CTE so it cannot
//                             drift from the edges it summarises.
//
// And the fifth, which is this project's whole disposition: `unresolved_calls`
// rows are attached as explicit unknown branches. An omitted branch reads as
// "this function calls nothing", which is a different and false claim from
// "we could not name what it calls".
// ============================================================================

import type { Confidence, FactStore } from "../store/db.ts";
import { parseRouteKey } from "../normalize/keys.ts";
import { displayNameOf } from "../static/scip/symbol.ts";

/** Edge types that mean "control or data leaves this symbol". */
const TRAVERSED = [
  "CALLS", "CALLS_EXTERNAL", "REQUESTS", "READS", "WRITES", "READS_CONFIG", "THROWS",
] as const;

const RANK: Record<Confidence, number> = {
  certain: 3, observed: 2, inferred: 1, unresolved: 0,
};

export function weakest(a: Confidence, b: Confidence): Confidence {
  return RANK[a] <= RANK[b] ? a : b;
}

export interface FlowNode {
  nodeId: number;
  kind: string;
  key: string;
  display: string;
  /** Type of the edge that reached this node; null at a chain root. */
  edgeType: string | null;
  /** Confidence of that edge. */
  edge: Confidence;
  /** Weakest edge on the whole path from the chain root (R36). */
  pathConfidence: Confidence;
  depth: number;
  file: string | null;
  line: number | null;
  detail: string | null;
  /** Terminal because its kind is not expandable (external/datastore/config). */
  boundary: boolean;
  /** Already on this path higher up; not expanded again. */
  cycle: boolean;
  /** Children withheld because the depth cap was reached, though some exist. */
  truncated: boolean;
  children: FlowNode[];
  /** Set on a `route` node reached across a REQUESTS edge. */
  remote?: EndpointFlow;
}

export interface ChainStep {
  position: number;
  phase: string;
  name: string | null;
  key: string | null;
  checkKind: string | null;
  origin: string;
  inheritedFrom: string | null;
  confidence: Confidence;
  evidenceKind: string;
  detail: string | null;
  symbolNodeId: number | null;
  symbolKey: string | null;
  /** Call tree beneath this step. Null when the chain entry joined no symbol. */
  tree: FlowNode | null;
}

export interface UnknownBranch {
  /** Symbol the gap belongs to, by key. */
  srcKey: string;
  srcDisplay: string;
  kind: string;
  targetHint: string | null;
  reason: string;
  file: string | null;
  line: number | null;
}

export interface EndpointFlow {
  service: string;
  method: string;
  url: string;
  routeKey: string;
  routeNodeId: number;
  /** Boot-channel steps, then `handler_inline` — never interleaved (R26/R50). */
  chain: ChainStep[];
  /** Gaps intersecting any symbol on this flow. R61's UNKNOWN section. */
  unknown: UnknownBranch[];
  /** Chain entries the index could not name. A gap, not a zero. */
  unjoined: ChainStep[];
  /** Remote services this flow entered, in the order first reached. */
  visitedServices: string[];
}

export interface FlowOptions {
  maxDepth?: number;
  /** Stop recursing into remote services. Useful for a single-service view. */
  followRemote?: boolean;
}

export class RouteNotFound extends Error {
  readonly candidates: Array<{ service: string; method: string; url: string }>;

  constructor(
    service: string, method: string, url: string,
    candidates: Array<{ service: string; method: string; url: string }>,
  ) {
    super(`no route ${method.toUpperCase()} ${url} in service ${service}`);
    this.name = "RouteNotFound";
    this.candidates = candidates;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function endpointFlow(
  store: FactStore, service: string, method: string, url: string,
  options: FlowOptions = {},
): EndpointFlow {
  const visited = new Set<string>();
  const flow = buildFlow(store, service, method, url, options, visited);
  flow.visitedServices = [...visited];
  return flow;
}

function buildFlow(
  store: FactStore, service: string, method: string, url: string,
  options: FlowOptions, visitedRoutes: Set<string>,
): EndpointFlow {
  const db = store.raw();
  const maxDepth = options.maxDepth ?? 12;
  const followRemote = options.followRemote ?? true;

  const route = db.prepare(
    `SELECT n.id AS node_id, r.service_name, r.method, r.url, n.key
       FROM routes r JOIN nodes n ON n.id = r.node_id
      WHERE r.service_name = ? AND r.method = ? AND r.url = ?`,
  ).get(service, method.toUpperCase(), url) as
    | { node_id: number; service_name: string; method: string; url: string; key: string }
    | undefined;

  if (!route) {
    const candidates = db.prepare(
      "SELECT service_name, method, url FROM routes WHERE service_name = ? ORDER BY url, method",
    ).all(service) as Array<{ service_name: string; method: string; url: string }>;
    throw new RouteNotFound(service, method, url, candidates.map((c) => ({
      service: c.service_name, method: c.method, url: c.url,
    })));
  }

  visitedRoutes.add(route.key);

  const chainRows = db.prepare(
    `SELECT rc.position, rc.phase, rc.name, rc.key, rc.check_kind, rc.origin,
            rc.inherited_from, rc.confidence, rc.evidence_kind, rc.detail,
            rc.symbol_node_id, rc.line, rc.end_line, n.key AS symbol_key
       FROM route_chain rc
       LEFT JOIN nodes n ON n.id = rc.symbol_node_id
      WHERE rc.route_node_id = ?
      ORDER BY (rc.phase = 'handler_inline'), rc.position`,
  ).all(route.node_id) as Array<Record<string, string | number | null>>;

  const chain: ChainStep[] = [];
  const unjoined: ChainStep[] = [];
  const symbolsOnPath = new Set<number>();

  for (const row of chainRows) {
    const symbolNodeId = row["symbol_node_id"] === null ? null : Number(row["symbol_node_id"]);
    const step: ChainStep = {
      position: Number(row["position"]),
      phase: String(row["phase"]),
      name: (row["name"] as string | null) ?? null,
      key: (row["key"] as string | null) ?? null,
      checkKind: (row["check_kind"] as string | null) ?? null,
      origin: String(row["origin"]),
      inheritedFrom: (row["inherited_from"] as string | null) ?? null,
      confidence: String(row["confidence"]) as Confidence,
      evidenceKind: String(row["evidence_kind"]),
      detail: (row["detail"] as string | null) ?? null,
      symbolNodeId,
      symbolKey: (row["symbol_key"] as string | null) ?? null,
      tree: null,
    };

    if (symbolNodeId !== null) {
      // An anonymous hook joined the MODULE, whose range is the whole file.
      // `end_line` (migration 004) is its real span, and scoping the root's
      // outgoing edges to it is what keeps the hook's tree from becoming every
      // call in the file (M7).
      const endLine = row["end_line"] === null ? null : Number(row["end_line"]);
      const scope = endLine !== null && row["line"] !== null
        ? { startLine: Number(row["line"]), endLine }
        : null;
      step.tree = expand(
        store, symbolNodeId, maxDepth, followRemote, visitedRoutes, symbolsOnPath, scope,
      );
    } else if (step.origin !== "framework" && step.phase !== "handler_inline") {
      // Framework code is never expected to join. Neither is an inline check:
      // it is a call SITE inside a handler, not a chain function, and it
      // deliberately stores a null symbol. Reporting either as unjoined would
      // manufacture a gap — which is as dishonest as hiding a real one.
      unjoined.push(step);
    }
    chain.push(step);
  }

  return {
    service: route.service_name,
    method: route.method,
    url: route.url,
    routeKey: route.key,
    routeNodeId: route.node_id,
    chain,
    unknown: gapsFor(store, symbolsOnPath),
    unjoined,
    visitedServices: [],
  };
}

// ---------------------------------------------------------------------------
// The closure
// ---------------------------------------------------------------------------

interface WalkRow {
  node_id: number;
  kind: string;
  key: string;
  depth: number;
  edge_type: string | null;
  edge_conf: string;
  path_conf: string;
  path: string;
  parent_id: number | null;
  file_path: string | null;
  line: number | null;
  detail: string | null;
}

/**
 * Depth-capped, cycle-guarded closure from one symbol (R35).
 *
 * The traversal is a recursive CTE rather than a loop of queries: at Phase 1
 * sizes both are instant, but the CTE keeps the depth cap, the cycle guard and
 * the `min_conf` fold in one place where they cannot disagree with each other.
 *
 * `min_conf` is folded in SQL for the same reason (R36). Computing it in
 * TypeScript afterwards would let the number drift from the edges it claims to
 * summarise the first time someone adds an edge type here and not there.
 */
export interface RootScope {
  startLine: number;
  endLine: number;
}

function expand(
  store: FactStore, rootId: number, maxDepth: number,
  followRemote: boolean, visitedRoutes: Set<string>, symbolsOnPath: Set<number>,
  scope: RootScope | null = null,
): FlowNode | null {
  const db = store.raw();
  const types = TRAVERSED.map(() => "?").join(", ");

  const rows = db.prepare(
    `WITH RECURSIVE walk(node_id, depth, edge_type, edge_conf, path_conf, path,
                         parent_id, file_id, line, detail) AS (
       SELECT ?, 0, NULL, 'certain', 'certain', '/' || ? || '/', NULL, NULL, NULL, NULL
       UNION ALL
       SELECT e.dst_node_id,
              w.depth + 1,
              e.type,
              e.confidence,
              CASE
                WHEN w.path_conf = 'unresolved' OR e.confidence = 'unresolved' THEN 'unresolved'
                WHEN w.path_conf = 'inferred'   OR e.confidence = 'inferred'   THEN 'inferred'
                WHEN w.path_conf = 'observed'   OR e.confidence = 'observed'   THEN 'observed'
                ELSE 'certain'
              END,
              -- The edge id, not just the node, keeps the path UNIQUE per row.
              -- Two call sites from one caller to one callee are two edges and
              -- would otherwise share a path key: the tree then pushed both as
              -- children while the map kept only the last, so grandchildren
              -- attached to one arbitrary duplicate (review, 2026-09-07).
              w.path || e.dst_node_id || '#' || e.id || '/',
              w.node_id,
              e.file_id, e.line, e.detail
         FROM walk w
         JOIN nodes src ON src.id = w.node_id
         JOIN edges e   ON e.src_node_id = w.node_id
        WHERE w.depth < ?
          -- Expand only out of symbols. external / datastore / config / route
          -- are terminals by KIND, so boundary termination needs no per-package
          -- rule and cannot be forgotten for a new node kind.
          AND src.kind = 'symbol'
          -- Cycle guard: refuse a node already on this path.
          -- Cycle guard is on the NODE, matched with its '#' delimiter so a
          -- node id is never confused with a longer one sharing its prefix.
          AND instr(w.path, '/' || e.dst_node_id || '#') = 0
          AND e.type IN (${types})
          -- Depth-0 narrowing: an anonymous hook's root is the module, so its
          -- own calls are only those inside the hook's line span.
          AND (w.depth > 0 OR ? IS NULL OR (e.line >= ? AND e.line <= ?))
     )
     SELECT w.node_id, n.kind, n.key, w.depth, w.edge_type, w.edge_conf,
            w.path_conf, w.path, w.parent_id, f.path AS file_path, w.line, w.detail
       FROM walk w
       JOIN nodes n ON n.id = w.node_id
       LEFT JOIN files f ON f.id = w.file_id
      ORDER BY w.depth, w.line, n.key`,
  ).all(
    rootId, rootId, maxDepth, ...TRAVERSED,
    scope ? 1 : null, scope?.startLine ?? 0, scope?.endLine ?? 0,
  ) as unknown as WalkRow[];

  if (rows.length === 0) return null;

  const byPath = new Map<string, FlowNode>();
  let root: FlowNode | null = null;

  for (const r of rows) {
    if (r.kind === "symbol") symbolsOnPath.add(r.node_id);

    const node: FlowNode = {
      nodeId: r.node_id,
      kind: r.kind,
      key: r.key,
      display: r.kind === "symbol" ? displayNameOf(r.key) : r.key,
      edgeType: r.edge_type,
      edge: (r.edge_conf as Confidence),
      pathConfidence: (r.path_conf as Confidence),
      depth: r.depth,
      file: r.file_path,
      line: r.line,
      detail: r.detail,
      boundary: r.kind !== "symbol",
      cycle: false,
      truncated: false,
      children: [],
    };
    byPath.set(r.path, node);

    if (r.parent_id === null) { root = node; continue; }
    // The path ends with this row's own '<dst>#<edge>/' segment; the parent is
    // everything before it.
    const parentPath = r.path.slice(0, r.path.lastIndexOf("/", r.path.length - 2) + 1);
    byPath.get(parentPath)?.children.push(node);
  }

  if (!root) return null;
  markStops(store, root, maxDepth);

  if (followRemote) {
    for (const node of byPath.values()) {
      if (node.kind !== "route") continue;
      const parsed = parseRouteKey(node.key);
      // The visited set is what makes two services calling each other
      // terminate. A route already on this flow renders as a boundary rather
      // than recursing, and `visitedServices` records that it was reached.
      if (!parsed || visitedRoutes.has(node.key)) continue;
      node.remote = buildFlow(
        store, parsed.service, parsed.method, parsed.url,
        { maxDepth, followRemote }, visitedRoutes,
      );
    }
  }

  return root;
}

/**
 * Mark the two reasons a node has no children other than "nothing is there".
 *
 * A leaf at the depth cap that DOES have outgoing edges is `truncated`; a node
 * whose key already appears above it on the path is a `cycle`. Both render
 * differently from an ordinary leaf, because "we stopped here" and "there is
 * nothing here" are different claims and only one of them is about the code.
 */
function markStops(store: FactStore, root: FlowNode, maxDepth: number): void {
  const outgoing = store.raw().prepare(
    `SELECT COUNT(*) AS n FROM edges e JOIN nodes src ON src.id = e.src_node_id
      WHERE e.src_node_id = ? AND src.kind = 'symbol'`,
  );

  const seenOnPath = (node: FlowNode, ancestors: Set<string>): void => {
    if (ancestors.has(node.key)) node.cycle = true;
    if (node.depth >= maxDepth && node.kind === "symbol" && node.children.length === 0) {
      node.truncated = (outgoing.get(node.nodeId) as { n: number }).n > 0;
    }
    const next = new Set(ancestors).add(node.key);
    for (const child of node.children) seenOnPath(child, next);
  };
  seenOnPath(root, new Set());
}

// ---------------------------------------------------------------------------
// R11 / R61 — the gaps
// ---------------------------------------------------------------------------

/**
 * `unresolved_calls` rows belonging to any symbol reached on this flow.
 *
 * These are attached as explicit unknown branches, not filtered out. On
 * `POST /api/v1/po` this is what surfaces `return axios(axiosConfig)` — the
 * router's only outbound HTTP call, whose callee resolves to a package
 * namespace and can never become a `CALLS` edge.
 */
function gapsFor(store: FactStore, symbols: Set<number>): UnknownBranch[] {
  if (symbols.size === 0) return [];
  const ids = [...symbols];
  const q = ids.map(() => "?").join(", ");
  const rows = store.raw().prepare(
    `SELECT n.key AS src_key, u.kind, u.target_hint, u.reason, f.path AS file_path, u.line
       FROM unresolved_calls u
       JOIN nodes n ON n.id = u.src_node_id
       LEFT JOIN files f ON f.id = u.file_id
      WHERE u.src_node_id IN (${q})
      ORDER BY f.path, u.line`,
  ).all(...ids) as Array<Record<string, string | number | null>>;

  return rows.map((r) => ({
    srcKey: String(r["src_key"]),
    srcDisplay: displayNameOf(String(r["src_key"])),
    kind: String(r["kind"]),
    targetHint: (r["target_hint"] as string | null) ?? null,
    reason: String(r["reason"]),
    file: (r["file_path"] as string | null) ?? null,
    line: r["line"] === null ? null : Number(r["line"]),
  }));
}
