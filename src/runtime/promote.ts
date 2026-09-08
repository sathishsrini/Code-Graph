// ============================================================================
// Runtime promotion  —  task P2-T9  (requirements R54, R56, R57)
// ============================================================================
// Joins spans to the graph and upgrades what they confirm.
//
// **R56 is the rule this file exists to obey: runtime NEVER deletes a static
// edge.** It upgrades `inferred` -> `observed`, or adds a new `observed` edge.
// Nothing here issues a DELETE against `edges`, and a test asserts it.
//
// The reasoning is the doc's organising principle read carefully. Traces
// establish boundaries *with certainty* — a span proves a call happened. They
// establish nothing about calls that did not happen today. A path nobody
// exercised is not a path that does not exist; it is a path nobody exercised,
// which is what R57's "possibly dead" says and is a weaker and truer claim.
//
// R54's join keys, and what each is worth:
//
//   service.name + http.route      -> routes      exact, and the strongest
//   code.function.name + file.path -> symbols     exact when instrumented
//   db.*                           -> datastore   engine+table, our key shape
//   server.address                 -> external / remote route
//   exception.*                    -> error origin (read by P2-T10)
// ============================================================================

import type { FactStore } from "../store/db.ts";
import { matchTemplate } from "./route-match.ts";

export interface PromotionReport {
  /** Spans whose `http.route` matched a route exactly. */
  matchedRoutes: number;
  /**
   * Spans matched by pattern-matching `url.path` against route templates.
   *
   * Counted apart from `matchedRoutes` because it is a weaker claim: the
   * traffic is observed, the route it hit is inferred.
   */
  routesByTemplate: number;
  matchedSymbols: number;
  matchedDatastores: number;
  /** Edges upgraded `inferred` -> `observed`. */
  promoted: number;
  /** Edges added because runtime saw a call the static channel did not. */
  added: number;
  /** Spans whose join keys matched nothing. A gap, reported not hidden. */
  unmatched: number;
  /** Edges never confirmed, older than the cutoff (R57). */
  possiblyDead: number;
}

export interface PromoteOptions {
  /** Days without confirmation before an edge is "possibly dead". Default 30. */
  deadAfterDays?: number;
  /**
   * Declared port -> service name, from `repos.json`.
   *
   * Needed to resolve a loopback `server.address`. Passed in because the store
   * has no port column, and adding one to answer this would be a column whose
   * only producer is a config file the caller already holds.
   */
  servicePorts?: Map<number, string>;
}

export function promote(
  store: FactStore, options: PromoteOptions = {},
): PromotionReport {
  const db = store.raw();
  const ports = options.servicePorts ?? new Map<number, string>();
  const report: PromotionReport = {
    matchedRoutes: 0, routesByTemplate: 0, matchedSymbols: 0, matchedDatastores: 0,
    promoted: 0, added: 0, unmatched: 0, possiblyDead: 0,
  };

  // --- server spans confirm a route was hit -------------------------------
  //
  // `http.route` is the template and is the exact join. It is also frequently
  // ABSENT: R52 claims it comes free from auto-instrumentation and measured
  // against this corpus it never arrived at all — the HTTP instrumentation
  // emits `url.path` (concrete) and only *framework* instrumentation upgrades
  // it (migration 007). So the concrete path is matched against templates as a
  // fallback, and `routesByTemplate` counts that separately because it is an
  // inference, not a lookup.
  const routeHits = db.prepare(
    `SELECT s.service_name, s.http_route, s.url_path, s.http_method,
            MAX(s.start_unix_us) AS last_us, COUNT(*) AS hits
       FROM spans s
      WHERE (s.http_route IS NOT NULL OR s.url_path IS NOT NULL)
        AND (s.kind IS NULL OR s.kind = 'server')
      GROUP BY s.service_name, s.http_route, s.url_path, s.http_method`,
  ).all() as Array<{
    service_name: string; http_route: string | null; url_path: string | null;
    http_method: string | null; last_us: number; hits: number;
  }>;

  const findRoute = db.prepare(
    `SELECT node_id FROM routes
      WHERE service_name = ? AND url = ? AND (? IS NULL OR method = ?)`,
  );

  for (const hit of routeHits) {
    let nodeId: number | undefined;

    if (hit.http_route) {
      nodeId = (findRoute.get(
        hit.service_name, hit.http_route, hit.http_method, hit.http_method,
      ) as { node_id: number } | undefined)?.node_id;
      if (nodeId !== undefined) report.matchedRoutes += 1;
    }

    if (nodeId === undefined && hit.url_path) {
      const matched = matchTemplate(store, hit.service_name, hit.url_path, hit.http_method);
      if (matched !== null) {
        nodeId = matched;
        report.routesByTemplate += 1;
      }
    }

    if (nodeId === undefined) { report.unmatched += 1; continue; }
    touch(store, nodeId, hit.last_us);
  }

  // --- client spans confirm a cross-service call --------------------------
  // A client span's parent is in the caller and its `http.route`/`server.address`
  // names the callee. That pair is exactly a REQUESTS edge, and it is the edge
  // P1-T7 could only ever mark `inferred`.
  const clientCalls = db.prepare(
    `SELECT child.service_name AS caller_service,
            child.http_route   AS callee_route,
            child.http_method  AS callee_method,
            child.server_address, child.server_port,
            parent.http_route  AS caller_route,
            parent.service_name AS parent_service,
            MAX(child.start_unix_us) AS last_us
       FROM spans child
       LEFT JOIN spans parent
              ON parent.span_id = child.parent_span_id
             AND parent.trace_id = child.trace_id
      WHERE child.kind = 'client' AND child.http_route IS NOT NULL
      GROUP BY child.service_name, child.http_route, child.http_method,
               child.server_address, child.server_port, parent.http_route, parent.service_name`,
  ).all() as Array<Record<string, string | number | null>>;

  for (const call of clientCalls) {
    const calleeService = serviceAtAddress(
      store, String(call["server_address"] ?? ""), ports,
      call["server_port"] === null ? null : Number(call["server_port"]),
    );
    if (!calleeService) { report.unmatched += 1; continue; }

    const callee = db.prepare(
      "SELECT node_id FROM routes WHERE service_name = ? AND url = ? AND method = ?",
    ).get(calleeService, String(call["callee_route"]), String(call["callee_method"] ?? "GET")) as
      | { node_id: number } | undefined;
    const caller = call["caller_route"]
      ? db.prepare(
          "SELECT node_id FROM routes WHERE service_name = ? AND url = ?",
        ).get(String(call["parent_service"]), String(call["caller_route"])) as
          | { node_id: number } | undefined
      : undefined;
    if (!callee || !caller) { report.unmatched += 1; continue; }

    const result = confirmEdge(
      store, caller.node_id, callee.node_id, "REQUESTS", Number(call["last_us"]),
    );
    if (result === "promoted") report.promoted += 1;
    if (result === "added") report.added += 1;
  }

  // --- code.* spans confirm a symbol ran ----------------------------------
  const codeHits = db.prepare(
    `SELECT code_function, code_filepath, MAX(start_unix_us) AS last_us
       FROM spans WHERE code_function IS NOT NULL
      GROUP BY code_function, code_filepath`,
  ).all() as Array<{ code_function: string; code_filepath: string | null; last_us: number }>;

  for (const hit of codeHits) {
    const row = db.prepare(
      `SELECT s.node_id FROM symbols s
         LEFT JOIN files f ON f.id = s.file_id
        WHERE s.display_name = ?
          AND (? IS NULL OR f.path = ? OR f.path LIKE '%' || ?)`,
    ).get(hit.code_function, hit.code_filepath, hit.code_filepath, hit.code_filepath) as
      | { node_id: number } | undefined;
    if (!row) { report.unmatched += 1; continue; }
    report.matchedSymbols += 1;
    touch(store, row.node_id, hit.last_us);
  }

  // --- db spans confirm a datastore was touched ---------------------------
  const dbHits = db.prepare(
    `SELECT db_system, db_name, db_operation, service_name, MAX(start_unix_us) AS last_us
       FROM spans WHERE db_system IS NOT NULL
      GROUP BY db_system, db_name, db_operation, service_name`,
  ).all() as Array<Record<string, string | number | null>>;

  for (const hit of dbHits) {
    // Same key shape the static channel writes: `<engine>://<db|?>/<table>`.
    const engine = String(hit["db_system"]).toLowerCase();
    const like = `${engine}://%`;
    const rows = db.prepare(
      "SELECT id FROM nodes WHERE kind = 'datastore' AND key LIKE ?",
    ).all(like) as Array<{ id: number }>;
    if (rows.length === 0) { report.unmatched += 1; continue; }
    report.matchedDatastores += rows.length;
    for (const row of rows) touch(store, row.id, Number(hit["last_us"]));
  }

  report.possiblyDead = countPossiblyDead(store, options.deadAfterDays ?? 30);
  return report;
}

/**
 * Record that a node was seen, on every edge that reaches it.
 *
 * `last_observed_at` only ever moves forward: an edge that stops being
 * observed keeps its last date, because "not seen since March" is the fact
 * R57 wants and "never seen" would be a different and false one.
 */
function touch(store: FactStore, nodeId: number, unixUs: number): void {
  store.raw().prepare(
    `UPDATE edges
        SET last_observed_at = MAX(COALESCE(last_observed_at, ''), ?)
      WHERE (src_node_id = ? OR dst_node_id = ?)`,
  ).run(isoFromUs(unixUs), nodeId, nodeId);
}

/**
 * Confirm an edge runtime saw (R56).
 *
 * Three outcomes, and none of them is a delete:
 *   - the edge exists and is `inferred`  -> upgraded to `observed`
 *   - the edge exists and is `certain`   -> left alone, only its date moves
 *   - the edge does not exist            -> added as `observed`/`otel`
 */
function confirmEdge(
  store: FactStore, srcNodeId: number, dstNodeId: number,
  type: string, unixUs: number,
): "promoted" | "added" | "confirmed" {
  const db = store.raw();
  const at = isoFromUs(unixUs);

  const existing = db.prepare(
    "SELECT id, confidence FROM edges WHERE src_node_id = ? AND dst_node_id = ? AND type = ?",
  ).get(srcNodeId, dstNodeId, type) as { id: number; confidence: string } | undefined;

  if (existing) {
    db.prepare("UPDATE edges SET last_observed_at = ? WHERE id = ?").run(at, existing.id);
    if (existing.confidence === "inferred") {
      db.prepare("UPDATE edges SET confidence = 'observed' WHERE id = ?").run(existing.id);
      return "promoted";
    }
    // `certain` is not downgraded to `observed`. The compiler resolved it;
    // a trace agreeing adds nothing, and a trace not covering it removes
    // nothing.
    return "confirmed";
  }

  const runId = latestRuntimeRun(store, srcNodeId);
  db.prepare(
    `INSERT INTO edges
       (src_node_id, dst_node_id, type, confidence, evidence_kind, run_id, last_observed_at)
     VALUES (?, ?, ?, 'observed', 'otel', ?, ?)
     ON CONFLICT DO NOTHING`,
  ).run(srcNodeId, dstNodeId, type, runId, at);
  return "added";
}

/** A `runtime` run to own otel-sourced rows, created on demand. */
function latestRuntimeRun(store: FactStore, nodeId: number): number {
  const db = store.raw();
  const existing = db.prepare(
    "SELECT id FROM runs WHERE channel = 'runtime' ORDER BY id DESC LIMIT 1",
  ).get() as { id: number } | undefined;
  if (existing) return existing.id;

  const repo = db.prepare("SELECT repo_id FROM nodes WHERE id = ?").get(nodeId) as
    { repo_id: number | null } | undefined;
  const anyRepo = db.prepare("SELECT id FROM repos ORDER BY id LIMIT 1").get() as
    { id: number } | undefined;
  const repoId = repo?.repo_id ?? anyRepo?.id;
  if (repoId === undefined) throw new Error("promote: no repo to own the runtime run");
  return store.startRun(repoId, "runtime", "otlp-receiver", "");
}

/**
 * Resolve `server.address` to a service (R54).
 *
 * Two ways, in order of how much they prove:
 *
 *   1. The address names the service directly — `engine:3002`, or a DNS name
 *      in a container network. Exact, and needs no configuration.
 *   2. Loopback plus a DECLARED port. `repos.json` carries the port; it is
 *      passed in rather than read from the store, because the store has no
 *      column for it and adding one would be a column with no producer.
 *      Declared, not guessed — the same rule the static linker follows, and
 *      for the same reason: `api.stripe.com:3002` must not resolve to the
 *      engine.
 *
 * Anything else returns null and the span counts as unmatched. A runtime
 * channel that invented a destination would be worse than the static one it
 * exists to confirm.
 */
function serviceAtAddress(
  store: FactStore, address: string, ports: Map<number, string>,
  serverPort: number | null = null,
): string | null {
  if (!address) return null;
  const bare = address.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const [host, portText] = bare.split(":");
  if (!host) return null;

  for (const repo of store.raw().prepare(
    "SELECT name, service_name FROM repos",
  ).all() as Array<{ name: string; service_name: string | null }>) {
    const service = repo.service_name ?? repo.name;
    if (host === service || host === repo.name) return service;
  }

  if (!LOOPBACK.has(host)) return null;
  // `server.port` is its own attribute; the address is often just the host.
  const port = Number(portText || serverPort);
  return Number.isFinite(port) ? ports.get(port) ?? null : null;
}

/** Hosts that can name a service running in this workspace. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

/**
 * R57: static edges with no runtime confirmation after `days`.
 *
 * Counted, never acted on. The doc is explicit that this is surfaced as
 * "possibly dead", not as proof — a route exercised once a quarter is not dead,
 * and an engine that deleted it would be wrong in the direction nobody notices
 * until the code is gone.
 */
export function countPossiblyDead(store: FactStore, days: number): number {
  const row = store.raw().prepare(
    `SELECT COUNT(*) AS n FROM edges
      WHERE evidence_kind IN ('scip', 'treesitter')
        AND (last_observed_at IS NULL OR last_observed_at < datetime('now', ?))`,
  ).get(`-${days} days`) as { n: number };
  return row.n;
}

export function possiblyDeadEdges(store: FactStore, days: number, limit = 50): Array<{
  src: string; dst: string; type: string; lastObserved: string | null;
}> {
  return (store.raw().prepare(
    `SELECT s.key AS src, d.key AS dst, e.type, e.last_observed_at
       FROM edges e
       JOIN nodes s ON s.id = e.src_node_id
       JOIN nodes d ON d.id = e.dst_node_id
      WHERE e.evidence_kind IN ('scip', 'treesitter')
        AND (e.last_observed_at IS NULL OR e.last_observed_at < datetime('now', ?))
      ORDER BY e.last_observed_at IS NOT NULL, e.last_observed_at
      LIMIT ?`,
  ).all(`-${days} days`, limit) as Array<Record<string, string | null>>).map((r) => ({
    src: String(r["src"]), dst: String(r["dst"]), type: String(r["type"]),
    lastObserved: r["last_observed_at"] ?? null,
  }));
}

function isoFromUs(unixUs: number): string {
  return new Date(Math.floor(unixUs / 1000)).toISOString().replace("T", " ").slice(0, 19);
}
