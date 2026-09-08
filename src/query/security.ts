// ============================================================================
// security_path  —  task P1-T14  (requirement R40)
// ============================================================================
// Three questions, deliberately three answers:
//
//   1. the ordered chain    what security runs on this route, in what order,
//                           and on whose word
//   2. the coverage matrix  routes x check kinds — what is present, what is
//                           absent, and which channel said so
//   3. the anomaly query    routes that write data with no tenant check
//
// The scope boundary matters more here than anywhere else in the engine, and
// the doc states it (§Q.3): **authorization correctness is out of scope.** This
// can say which checks run in what order. It cannot say whether
// `requireRole('admin')` should have been `requireRole('owner')`. So the
// flagship question is "routes that write data with no tenant check", never
// "this endpoint is secure" — the first is answerable from evidence, the second
// is a judgement no graph contains.
//
// The two channels are never merged into one verdict:
//
//   boot     certain    the framework reported this hook. It runs.
//   inline   inferred   a parser found a check in the handler body.
//
// A route protected only by an inline check is protected — `POST /api/v1/po`
// is exactly that — but the evidence is weaker, and a coverage matrix that
// renders both as a tick has quietly converted an inference into a fact.
// Everything below carries the channel.
// ============================================================================

import type { FactStore } from "../store/db.ts";
import { displayNameOf } from "../static/scip/symbol.ts";

/** Check kinds the coverage matrix reports on, in the order it reports them. */
export const CHECK_KINDS = ["auth", "tenant", "rbac", "ratelimit"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number] | string;

export type Channel = "boot" | "inline";

export interface CheckRow {
  position: number;
  phase: string;
  name: string | null;
  checkKind: string;
  channel: Channel;
  confidence: string;
  evidenceKind: string;
  /** P1-T10's reviewed-helper-vs-shape discriminator, when there is one. */
  detail: string | null;
  file: string | null;
  line: number | null;
}

export interface RouteSecurity {
  nodeId: number;
  key: string;
  service: string;
  method: string;
  url: string;
  /** Every chain entry carrying a `check_kind`, boot first then inline. */
  checks: CheckRow[];
  /** Kinds present, and by which channel. Absent kinds are simply missing. */
  coverage: Record<string, Channel[]>;
  /** Datastore writes this route can reach. Empty is not proof of none. */
  writes: WriteReach[];
}

export interface WriteReach {
  datastore: string;
  /**
   * How the write was reached.
   *
   * `call` — a symbol on this route's chain reaches the write through the call
   *          graph. Precise.
   * `file` — the write is attributed to a FILE this route's chain lives in.
   *          Every SQL literal in this corpus lands here, because they sit at
   *          module scope or inside anonymous handlers and the ingester
   *          refuses to guess a function. Real, but coarser than the route.
   */
  via: "call" | "file";
  detail: string | null;
}

export interface Anomaly {
  route: RouteSecurity;
  reason: string;
  /** Kinds that ARE present, so the reader sees what the route does have. */
  has: string[];
}

export interface SecurityReport {
  routes: RouteSecurity[];
  /** Kinds seen anywhere, so the matrix has columns even for a sparse corpus. */
  kinds: string[];
  anomalies: Anomaly[];
  /** Routes with no check of any kind, from either channel. */
  unprotected: RouteSecurity[];
  /**
   * Chain entries the index could not name, per route.
   *
   * R61 in its security form. A route whose chain has an unjoined entry may
   * run a check this query cannot see, and reporting it as unprotected without
   * saying so would be the worst output this engine can produce.
   */
  blindSpots: Array<{ routeKey: string; phase: string; key: string | null }>;
}

export interface SecurityOptions {
  service?: string;
  /** The kind whose absence, over a write, is the anomaly. Default `tenant`. */
  anomalyKind?: string;
  maxDepth?: number;
}

// ---------------------------------------------------------------------------

export function securityPath(
  store: FactStore, options: SecurityOptions = {},
): SecurityReport {
  const db = store.raw();
  const anomalyKind = options.anomalyKind ?? "tenant";
  const maxDepth = options.maxDepth ?? 12;

  const routeRows = db.prepare(
    `SELECT n.id AS node_id, n.key, r.service_name, r.method, r.url
       FROM routes r JOIN nodes n ON n.id = r.node_id
      ${options.service ? "WHERE r.service_name = ?" : ""}
      ORDER BY r.service_name, r.url, r.method`,
  ).all(...(options.service ? [options.service] : [])) as Array<{
    node_id: number; key: string; service_name: string; method: string; url: string;
  }>;

  const checkStmt = db.prepare(
    `SELECT rc.position, rc.phase, rc.name, rc.check_kind, rc.confidence,
            rc.evidence_kind, rc.detail, rc.line, f.path AS file
       FROM route_chain rc
       LEFT JOIN files f ON f.id = rc.file_id
      WHERE rc.route_node_id = ? AND rc.check_kind IS NOT NULL
      ORDER BY (rc.phase = 'handler_inline'), rc.position`,
  );

  const blindStmt = db.prepare(
    `SELECT rc.phase, rc.key
       FROM route_chain rc
      WHERE rc.route_node_id = ?
        AND rc.symbol_node_id IS NULL
        AND rc.origin NOT IN ('framework', 'handler')`,
  );

  const kinds = new Set<string>(CHECK_KINDS);
  const routes: RouteSecurity[] = [];
  const blindSpots: SecurityReport["blindSpots"] = [];

  for (const r of routeRows) {
    const checks = (checkStmt.all(r.node_id) as Array<Record<string, string | number | null>>)
      .map((row): CheckRow => {
        const evidence = String(row["evidence_kind"]);
        return {
          position: Number(row["position"]),
          phase: String(row["phase"]),
          name: (row["name"] as string | null) ?? null,
          checkKind: String(row["check_kind"]),
          channel: evidence === "boot" ? "boot" : "inline",
          confidence: String(row["confidence"]),
          evidenceKind: evidence,
          detail: (row["detail"] as string | null) ?? null,
          file: (row["file"] as string | null) ?? null,
          line: row["line"] === null ? null : Number(row["line"]),
        };
      });

    const coverage: Record<string, Channel[]> = {};
    for (const c of checks) {
      kinds.add(c.checkKind);
      (coverage[c.checkKind] ??= []).push(c.channel);
    }

    const route: RouteSecurity = {
      nodeId: r.node_id, key: r.key, service: r.service_name,
      method: r.method, url: r.url, checks, coverage,
      writes: writesReachableFrom(store, r.node_id, maxDepth),
    };
    routes.push(route);

    for (const b of blindStmt.all(r.node_id) as Array<{ phase: string; key: string | null }>) {
      blindSpots.push({ routeKey: r.key, phase: b.phase, key: b.key });
    }
  }

  // R40's flagship query. Deliberately "writes without a tenant check", not
  // "insecure": the first is answerable from evidence in the store.
  const anomalies: Anomaly[] = routes
    .filter((route) => route.writes.length > 0 && !(anomalyKind in route.coverage))
    .map((route) => ({
      route,
      reason: `reaches ${route.writes.length} datastore write(s) with no '${anomalyKind}' check`,
      has: Object.keys(route.coverage).sort(),
    }));

  return {
    routes,
    kinds: [...kinds],
    anomalies,
    unprotected: routes.filter((route) => route.checks.length === 0),
    blindSpots,
  };
}

/**
 * Datastore writes a route can reach.
 *
 * Two passes, because the corpus needs both and they are different strengths:
 *
 *   `call` — forward closure over CALLS from the route's chain symbols. This is
 *            the precise answer and the one a typed codebase produces.
 *   `file` — writes owned by a FILE that a chain entry lives in. Every SQL
 *            literal here lands on a file node, so without this pass the
 *            anomaly query returns nothing at all on a corpus where every
 *            write route is genuinely un-scoped — a false all-clear, which is
 *            the worst possible output for a security question.
 */
function writesReachableFrom(
  store: FactStore, routeNodeId: number, maxDepth: number,
): WriteReach[] {
  const out = new Map<string, WriteReach>();

  for (const row of store.raw().prepare(
    `WITH RECURSIVE reach(node_id, depth, path) AS (
       SELECT rc.symbol_node_id, 0, '/' || rc.symbol_node_id || '/'
         FROM route_chain rc
        WHERE rc.route_node_id = ? AND rc.symbol_node_id IS NOT NULL
       UNION
       SELECT e.dst_node_id, r.depth + 1, r.path || e.dst_node_id || '/'
         FROM reach r
         JOIN nodes src ON src.id = r.node_id
         JOIN edges e ON e.src_node_id = r.node_id
        WHERE r.depth < ? AND src.kind = 'symbol' AND e.type = 'CALLS'
          AND instr(r.path, '/' || e.dst_node_id || '/') = 0
     )
     SELECT DISTINCT n.key, e.detail
       FROM reach r
       JOIN edges e ON e.src_node_id = r.node_id
       JOIN nodes n ON n.id = e.dst_node_id
      WHERE e.type = 'WRITES' AND n.kind = 'datastore'`,
  ).all(routeNodeId, maxDepth) as Array<{ key: string; detail: string | null }>) {
    out.set(row.key, { datastore: row.key, via: "call", detail: row.detail });
  }

  // The file-scope pass is bounded by the HANDLER'S OWN LINE SPAN, not by the
  // file. Unbounded, every route in `41-kri-engine/server.js` reported writes
  // to all four tables — `GET /health` included — which is 21 of 21 routes
  // flagged and therefore indistinguishable from no answer at all (doc §Q.3's
  // warning, arriving from the security side).
  //
  // The span is already stored: `end_line` for an anonymous handler
  // (migration 004), `symbols.start_line`/`end_line` for a named one. Both are
  // coalesced here, so a write attributes to the route whose body contains it.
  for (const row of store.raw().prepare(
    `SELECT DISTINCT n.key, e.detail
       FROM route_chain rc
       JOIN files f ON f.id = rc.file_id
       JOIN nodes fn ON fn.kind = 'file' AND fn.key LIKE '%/' || f.path
       JOIN edges e ON e.src_node_id = fn.id AND e.file_id = rc.file_id
       JOIN nodes n ON n.id = e.dst_node_id
       LEFT JOIN symbols s ON s.node_id = rc.symbol_node_id
      WHERE rc.route_node_id = ?
        AND rc.phase IN ('handler', 'handler_inline')
        AND e.type = 'WRITES' AND n.kind = 'datastore'
        AND e.line >= COALESCE(rc.line, s.start_line)
        AND e.line <= COALESCE(rc.end_line, s.end_line, rc.line)`,
  ).all(routeNodeId) as Array<{ key: string; detail: string | null }>) {
    if (out.has(row.key)) continue;
    out.set(row.key, { datastore: row.key, via: "file", detail: row.detail });
  }

  return [...out.values()].sort((a, b) => a.datastore.localeCompare(b.datastore));
}

/** The ordered chain for one route, security entries and all, for the CLI. */
export function chainOf(store: FactStore, routeNodeId: number): Array<{
  position: number; phase: string; name: string | null; checkKind: string | null;
  channel: Channel; confidence: string; detail: string | null; symbol: string | null;
}> {
  return (store.raw().prepare(
    `SELECT rc.position, rc.phase, rc.name, rc.check_kind, rc.confidence,
            rc.evidence_kind, rc.detail, n.key AS symbol_key
       FROM route_chain rc
       LEFT JOIN nodes n ON n.id = rc.symbol_node_id
      WHERE rc.route_node_id = ?
      ORDER BY (rc.phase = 'handler_inline'), rc.position`,
  ).all(routeNodeId) as Array<Record<string, string | number | null>>).map((r) => ({
    position: Number(r["position"]),
    phase: String(r["phase"]),
    name: (r["name"] as string | null) ?? null,
    checkKind: (r["check_kind"] as string | null) ?? null,
    channel: String(r["evidence_kind"]) === "boot" ? "boot" as const : "inline" as const,
    confidence: String(r["confidence"]),
    detail: (r["detail"] as string | null) ?? null,
    symbol: r["symbol_key"] === null ? null : displayNameOf(String(r["symbol_key"])),
  }));
}
