// ============================================================================
// Anonymous-handler attribution  —  slice CTX-S10a  (R11, R28, R36)
// ============================================================================
// A call or SQL literal inside an anonymous route handler has no enclosing
// definition of its own. SCIP attributes the call to the MODULE, and
// `ingestFindings` attributes the finding to the FILE — the width M7 recorded
// for anonymous hooks. On the corpus that hid a real caller: `context_pack
// checkUserAuth` did not list `POST /api/v1/mail/send` (M11 #1), and 25 of the
// engine's SQL/config findings sat on the file (plan §2.6).
//
// The route is recoverable without inventing anything. Boot located the
// handler (`route_chain.line`, from V8's [[FunctionLocation]]) and P1-T12
// bounded it (`end_line`, stored exactly for anonymous joins). A site inside
// that range was written by that handler, so it is credited to the ROUTE —
// the only node that already names an anonymous handler. No synthetic symbol
// is composed (R4), and no row is added: the credit is derived here, at read
// time, from two facts that each have their own provenance and are replaced
// by it (edges by file, R28; chain rows by boot run, R24). It cannot go stale,
// because there is nothing to delete.
//
// Two rules, both stated rather than tuned:
//
//   Confidence   the weakest of the edge and the range row (R36). A boot row
//                is `certain`, so the underlying edge's confidence survives;
//                a range a parser produced would make the credit `inferred`.
//
//   Opening line an edge has a line and no column, and the handler's opening
//                line also holds the call that REGISTERS it (`app.post(`), the
//                M7 case `DerivedCall.col` exists for. So the range is the
//                lines AFTER the opening one; a site on it stays file-scope,
//                and is counted as such rather than guessed.
//
// What is not credited stays where it was, and `fileScopeTally` counts it.
// ============================================================================

import type { Confidence, EdgeType, FactStore } from "../store/db.ts";

/**
 * SQL: edge `e` lies inside the anonymous-handler range of chain row `rc`.
 *
 * The one predicate every consumer uses — the queries, the exclusions and the
 * index report's count — so the number a reader is shown is the number the
 * queries act on. `end_line` is set only where the boot join landed on a
 * module (migration 004), so a non-null value already means "anonymous".
 */
export function inHandlerRange(e: string, rc: string): string {
  return `${rc}.phase = 'handler' AND ${rc}.end_line IS NOT NULL
          AND ${rc}.file_id = ${e}.file_id
          AND ${e}.line > ${rc}.line AND ${e}.line <= ${rc}.end_line`;
}

/** SQL: node `n` (with its `symbols` row `s`) is a module or a file — not an owner. */
function wideSource(n: string, s: string): string {
  return `(${n}.kind = 'file' OR ${s}.symbol_kind = 'namespace')`;
}

export interface HandlerCredit {
  routeNodeId: number;
  routeKey: string;
  service: string;
  method: string;
  url: string;
  /** The range row's own confidence. `certain` for a boot row. */
  rangeConfidence: Confidence;
}

/** One module- or file-scope edge, and the route(s) its site is credited to. */
export interface ScopedSite {
  srcNodeId: number;
  srcKey: string;
  dstNodeId: number;
  type: EdgeType;
  /** The underlying edge's confidence, unchanged. */
  confidence: Confidence;
  file: string | null;
  line: number;
  /**
   * The innermost anonymous handler holding the site. More than one route
   * only when they share that handler (a synthesised HEAD, a multi-method
   * route). Empty: the site is still module/file scope.
   */
  routes: HandlerCredit[];
}

/**
 * Module- and file-scope edges into `dstIds`, each with the routes whose
 * anonymous handler holds its site.
 */
export function scopedSitesInto(
  store: FactStore, dstIds: number[], types: readonly EdgeType[],
): ScopedSite[] {
  if (dstIds.length === 0 || types.length === 0) return [];
  const rows = store.raw().prepare(
    `SELECT e.id, e.src_node_id, sn.key AS src_key, e.dst_node_id, e.type,
            e.confidence, f.path AS file, e.line,
            rc.route_node_id, rc.line AS rc_line, rc.confidence AS rc_conf,
            rn.key AS route_key, r.service_name, r.method, r.url
       FROM edges e
       JOIN nodes sn ON sn.id = e.src_node_id
       LEFT JOIN symbols ss ON ss.node_id = sn.id
       LEFT JOIN files f ON f.id = e.file_id
       LEFT JOIN route_chain rc ON ${inHandlerRange("e", "rc")}
       LEFT JOIN routes r ON r.node_id = rc.route_node_id
       LEFT JOIN nodes rn ON rn.id = rc.route_node_id
      WHERE e.dst_node_id IN (${dstIds.map(() => "?").join(", ")})
        AND e.type IN (${types.map(() => "?").join(", ")})
        AND e.line IS NOT NULL
        AND ${wideSource("sn", "ss")}
      ORDER BY e.id, rc.line DESC, rn.key`,
  ).all(...dstIds, ...types) as Array<Record<string, string | number | null>>;

  const sites = new Map<number, ScopedSite>();
  // Ranges nest, so the innermost starts latest; rows arrive latest first.
  const innermost = new Map<number, number>();
  for (const r of rows) {
    const id = Number(r["id"]);
    let site = sites.get(id);
    if (!site) {
      site = {
        srcNodeId: Number(r["src_node_id"]),
        srcKey: String(r["src_key"]),
        dstNodeId: Number(r["dst_node_id"]),
        type: String(r["type"]) as EdgeType,
        confidence: String(r["confidence"]) as Confidence,
        file: (r["file"] as string | null) ?? null,
        line: Number(r["line"]),
        routes: [],
      };
      sites.set(id, site);
      if (r["rc_line"] !== null) innermost.set(id, Number(r["rc_line"]));
    }
    // A route row whose table entry is missing is skipped, never guessed.
    if (r["route_node_id"] === null || r["route_key"] === null) continue;
    if (Number(r["rc_line"]) !== innermost.get(id)) continue;
    site.routes.push({
      routeNodeId: Number(r["route_node_id"]),
      routeKey: String(r["route_key"]),
      service: String(r["service_name"] ?? ""),
      method: String(r["method"] ?? ""),
      url: String(r["url"] ?? ""),
      rangeConfidence: String(r["rc_conf"]) as Confidence,
    });
  }
  return [...sites.values()];
}

// ---------------------------------------------------------------------------
// The count the index report shows
// ---------------------------------------------------------------------------

export interface FileScopeTally {
  /** Module-scope `CALLS` / `CALLS_EXTERNAL` (evidence scip). */
  calls: { credited: number; moduleScope: number };
  /** File-scope `THROWS` / `READS` / `WRITES` / `READS_CONFIG` (evidence treesitter). */
  findings: { credited: number; fileScope: number };
  /** Every site still at module/file scope, so each one can be explained. */
  remaining: Array<{ file: string; line: number | null; type: string; target: string }>;
}

/**
 * What an anonymous handler's range credits in one repo, and what it leaves.
 *
 * Counted from the store with `inHandlerRange`, so it is the number the
 * queries act on. It counts EDGES: two identical findings on one line are one
 * edge, the same collapse every query sees.
 */
export function fileScopeTally(store: FactStore, repoId: number): FileScopeTally {
  const rows = store.raw().prepare(
    `SELECT e.type, f.path AS file, e.line, dn.key AS target,
            EXISTS (SELECT 1 FROM route_chain rc WHERE ${inHandlerRange("e", "rc")}) AS credited
       FROM edges e
       JOIN files f ON f.id = e.file_id
       JOIN nodes sn ON sn.id = e.src_node_id
       LEFT JOIN symbols ss ON ss.node_id = sn.id
       JOIN nodes dn ON dn.id = e.dst_node_id
      WHERE f.repo_id = ?
        AND ((sn.kind = 'file' AND e.evidence_kind = 'treesitter'
              AND e.type IN ('THROWS', 'READS', 'WRITES', 'READS_CONFIG'))
          OR (ss.symbol_kind = 'namespace' AND e.evidence_kind = 'scip'
              AND e.type IN ('CALLS', 'CALLS_EXTERNAL')))
      ORDER BY f.path, e.line, e.type, dn.key`,
  ).all(repoId) as Array<{
    type: string; file: string; line: number | null; target: string; credited: number;
  }>;

  const tally: FileScopeTally = {
    calls: { credited: 0, moduleScope: 0 },
    findings: { credited: 0, fileScope: 0 },
    remaining: [],
  };
  for (const r of rows) {
    const isCall = r.type === "CALLS" || r.type === "CALLS_EXTERNAL";
    if (r.credited) {
      if (isCall) tally.calls.credited += 1; else tally.findings.credited += 1;
      continue;
    }
    if (isCall) tally.calls.moduleScope += 1; else tally.findings.fileScope += 1;
    tally.remaining.push({ file: r.file, line: r.line, type: r.type, target: r.target });
  }
  return tally;
}
