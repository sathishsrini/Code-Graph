// ============================================================================
// error_paths  —  task P2-T10  (requirements R41, R59, R60, R61)
// ============================================================================
// "What can and did fail here?" — and the answer is deliberately not one
// answer.
//
// **R41 is the shape of this file.** The static failure surface and the runtime
// pass are two independent passes, presented separately, never merged into one
// verdict. They are different kinds of claim:
//
//   OBSERVED               a trace says this failed. Certain, and about the
//                          past — it says nothing about what else can fail.
//   STATIC FAILURE SURFACE the code can fail here. Inferred, and about the
//                          possible — it says nothing about what did.
//   CORRELATED CHANGES     someone changed this recently. A ranking signal,
//                          and never evidence on its own.
//
// Merging them produces a single confident number that is wrong in both
// directions at once: it overstates the observed (by adding possibilities) and
// understates the static (by weighting on traffic).
//
// **R61's UNKNOWN line is mandatory and is emitted even when empty.** Omitting
// what could not be analysed converts an unknown into a false negative, and on
// this corpus the unknowns are large — `51-integration` has no symbols at all.
// ============================================================================

import { execFileSync } from "node:child_process";
import type { FactStore } from "../store/db.ts";
import { displayNameOf } from "../static/scip/symbol.ts";

// ---------------------------------------------------------------------------
// M.1 — the static failure surface
// ---------------------------------------------------------------------------

export interface StaticFailure {
  symbol: string;
  display: string;
  file: string | null;
  line: number | null;
  /** `throw` | `return_error` — the FORM, because they are not equivalent. */
  form: string;
  /** Error constructor or error-code literal, when detectable. */
  errorName: string | null;
  /** The condition guarding this exit, from the CFG. */
  guardedBy: string | null;
  evidence: "treesitter-cfg" | "throws-edge";
}

/**
 * Everything on this route that can fail, from source alone.
 *
 * Two producers, and the second is the one that matters here. `THROWS` edges
 * are the doc's original mechanism and are **3 rows across the whole corpus**;
 * `function_cfg` error exits are **7 on the router alone**, because the code
 * returns error envelopes rather than throwing. A surface built from `THROWS`
 * only would report almost nothing and look complete doing it (D12).
 */
export function staticFailureSurface(
  store: FactStore, routeNodeId: number, maxDepth = 12,
): StaticFailure[] {
  const reachable = reachableSymbols(store, routeNodeId, maxDepth);
  if (reachable.length === 0) return [];
  const q = reachable.map(() => "?").join(", ");

  const fromCfg = store.raw().prepare(
    `SELECT n.key, f.path AS file, c.start_line, c.exit_form, c.error_name,
            parent.condition_text AS guard
       FROM function_cfg c
       JOIN nodes n ON n.id = c.symbol_node_id
       LEFT JOIN files f ON f.id = c.file_id
       LEFT JOIN function_cfg parent
              ON parent.symbol_node_id = c.symbol_node_id
             AND parent.block_index = c.parent_index
      WHERE c.symbol_node_id IN (${q})
        AND c.kind = 'exit' AND c.outcome = 'error_exit'
      ORDER BY f.path, c.start_line`,
  ).all(...reachable) as Array<Record<string, string | number | null>>;

  const fromThrows = store.raw().prepare(
    `SELECT s.key, f.path AS file, e.line, e.detail, d.key AS error_key
       FROM edges e
       JOIN nodes s ON s.id = e.src_node_id
       JOIN nodes d ON d.id = e.dst_node_id
       LEFT JOIN files f ON f.id = e.file_id
      WHERE e.type = 'THROWS' AND e.src_node_id IN (${q})
      ORDER BY f.path, e.line`,
  ).all(...reachable) as Array<Record<string, string | number | null>>;

  const out: StaticFailure[] = fromCfg.map((r) => ({
    symbol: String(r["key"]),
    display: displayNameOf(String(r["key"])),
    file: (r["file"] as string | null) ?? null,
    line: r["start_line"] === null ? null : Number(r["start_line"]),
    form: String(r["exit_form"] ?? "return_error"),
    errorName: (r["error_name"] as string | null) ?? null,
    guardedBy: (r["guard"] as string | null) ?? null,
    evidence: "treesitter-cfg",
  }));

  for (const r of fromThrows) {
    const line = r["line"] === null ? null : Number(r["line"]);
    // A `throw` the CFG already recorded at this position is the same fact
    // arriving twice, not two failure modes.
    if (out.some((x) => x.symbol === String(r["key"]) && x.line === line)) continue;
    out.push({
      symbol: String(r["key"]),
      display: displayNameOf(String(r["key"])),
      file: (r["file"] as string | null) ?? null,
      line,
      form: "throw",
      errorName: String(r["error_key"] ?? "").replace(/^error:/, "") || null,
      guardedBy: null,
      evidence: "throws-edge",
    });
  }
  return out;
}

/** Symbols reachable from a route's chain, over CALLS. */
function reachableSymbols(store: FactStore, routeNodeId: number, maxDepth: number): number[] {
  return (store.raw().prepare(
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
     SELECT DISTINCT node_id FROM reach`,
  ).all(routeNodeId, maxDepth) as Array<{ node_id: number }>).map((r) => r.node_id);
}

// ---------------------------------------------------------------------------
// M.2 — trace root cause (R59)
// ---------------------------------------------------------------------------

export interface TraceSpan {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  service: string;
  status: string;
  depth: number;
  exceptionType: string | null;
  exceptionMessage: string | null;
  httpRoute: string | null;
  httpStatus: number | null;
  durationUs: number;
}

export interface RootCause {
  traceId: string;
  /** The DEEPEST error span — R59's origin. */
  origin: TraceSpan | null;
  /** Origin first, then each ancestor up to the root: the propagation chain. */
  propagation: TraceSpan[];
  spans: TraceSpan[];
}

/**
 * The deepest error span, and the chain above it (R59).
 *
 * "Deepest" is the whole point. A failing request produces an errored span at
 * every level — the handler, its caller, the server span — and the shallowest
 * is the one a naive query finds first. It is also the least useful: it says
 * "the request failed", which the status code already said. The deepest one
 * is where it actually broke.
 */
export function traceRootCause(store: FactStore, traceId: string): RootCause {
  const rows = store.raw().prepare(
    `SELECT span_id, parent_span_id, name, service_name, status,
            exception_type, exception_message, http_route, http_status, duration_us
       FROM spans WHERE trace_id = ? ORDER BY start_unix_us`,
  ).all(traceId) as Array<Record<string, string | number | null>>;

  const byId = new Map<string, TraceSpan>();
  for (const r of rows) {
    byId.set(String(r["span_id"]), {
      spanId: String(r["span_id"]),
      parentSpanId: (r["parent_span_id"] as string | null) ?? null,
      name: String(r["name"]),
      service: String(r["service_name"]),
      status: String(r["status"]),
      depth: 0,
      exceptionType: (r["exception_type"] as string | null) ?? null,
      exceptionMessage: (r["exception_message"] as string | null) ?? null,
      httpRoute: (r["http_route"] as string | null) ?? null,
      httpStatus: r["http_status"] === null ? null : Number(r["http_status"]),
      durationUs: Number(r["duration_us"] ?? 0),
    });
  }

  // Depth by walking to the root, with a guard: a malformed trace can contain
  // a parent cycle, and an unguarded walk would hang the query.
  for (const span of byId.values()) {
    const seen = new Set<string>();
    let current: TraceSpan | undefined = span;
    let depth = 0;
    while (current?.parentSpanId && !seen.has(current.spanId)) {
      seen.add(current.spanId);
      current = byId.get(current.parentSpanId);
      depth += 1;
      if (!current) break;
    }
    span.depth = depth;
  }

  const errors = [...byId.values()].filter((s) => s.status === "error");
  const origin = errors.length === 0
    ? null
    : errors.reduce((deepest, s) => (s.depth > deepest.depth ? s : deepest));

  const propagation: TraceSpan[] = [];
  if (origin) {
    const seen = new Set<string>();
    let current: TraceSpan | undefined = origin;
    while (current && !seen.has(current.spanId)) {
      seen.add(current.spanId);
      propagation.push(current);
      current = current.parentSpanId ? byId.get(current.parentSpanId) : undefined;
    }
  }

  return { traceId, origin, propagation, spans: [...byId.values()] };
}

/** Recent errored traces touching a route, newest first. */
export function erroredTracesFor(
  store: FactStore, service: string, url: string, limit = 10,
): Array<{ traceId: string; when: string; status: number | null }> {
  return (store.raw().prepare(
    `SELECT DISTINCT s.trace_id, s.start_unix_us, s.http_status
       FROM spans s
      WHERE s.service_name = ? AND s.http_route = ?
        AND s.trace_id IN (SELECT trace_id FROM spans WHERE status = 'error')
      ORDER BY s.start_unix_us DESC LIMIT ?`,
  ).all(service, url, limit) as Array<Record<string, string | number | null>>).map((r) => ({
    traceId: String(r["trace_id"]),
    when: new Date(Number(r["start_unix_us"]) / 1000).toISOString(),
    status: r["http_status"] === null ? null : Number(r["http_status"]),
  }));
}

// ---------------------------------------------------------------------------
// M.3 — correlated changes (R60)
// ---------------------------------------------------------------------------

export interface CorrelatedChange {
  file: string;
  lastCommit: string;
  lastAuthor: string;
  lastDate: string;
  subject: string;
}

export interface CorrelationResult {
  changes: CorrelatedChange[];
  /** Why the list is empty, when it is. Not the same as "nothing changed". */
  unavailable: string | null;
}

/**
 * Recent commits touching the files on a failing path (R60).
 *
 * A ranking signal, never evidence. "This file changed on Tuesday and the
 * errors started on Tuesday" is a lead worth following and is not a cause;
 * presenting it as one is how a correlation engine starts producing confident
 * nonsense.
 *
 * A repo that is not under git returns `unavailable` with the reason, because
 * an empty list would otherwise read as "nothing changed recently".
 */
export function correlatedChanges(
  store: FactStore, files: string[], sinceDays = 30,
): CorrelationResult {
  if (files.length === 0) return { changes: [], unavailable: null };

  const roots = new Map<string, string>();
  for (const file of files) {
    const row = store.raw().prepare(
      `SELECT r.root_path FROM files f JOIN repos r ON r.id = f.repo_id
        WHERE f.path = ? LIMIT 1`,
    ).get(file) as { root_path: string } | undefined;
    if (row) roots.set(file, row.root_path);
  }

  // A literal 0x1F in source is invisible and survives no copy-paste. git's
  // %x1f emits it; this names it.
  const SEP = String.fromCharCode(0x1f);
  const changes: CorrelatedChange[] = [];
  const failures: string[] = [];

  for (const [file, root] of roots) {
    try {
      const out = execFileSync("git", [
        "-C", root, "log", "-1", `--since=${sinceDays}.days`,
        "--format=%h%x1f%an%x1f%ad%x1f%s", "--date=short", "--", file,
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      if (out === "") continue;
      const [lastCommit, lastAuthor, lastDate, subject] = out.split(SEP);
      changes.push({
        file,
        lastCommit: lastCommit ?? "",
        lastAuthor: lastAuthor ?? "",
        lastDate: lastDate ?? "",
        subject: subject ?? "",
      });
    } catch {
      failures.push(root);
    }
  }

  return {
    changes,
    unavailable: failures.length > 0 && changes.length === 0
      ? `not a git repository (or git unavailable): ${[...new Set(failures)].join(", ")}`
      : null,
  };
}

// ---------------------------------------------------------------------------
// M.4 — the three-section report (R41, R61)
// ---------------------------------------------------------------------------

export interface ErrorReport {
  service: string;
  method: string;
  url: string;
  routeNodeId: number;
  /** Section 1. Empty means no trace, NOT no failures. */
  observed: RootCause[];
  observedAvailable: boolean;
  /** Section 2. Independent of section 1, and never merged with it. */
  staticSurface: StaticFailure[];
  /** Section 3. A ranking signal only. */
  correlation: CorrelationResult;
  /** Section 4, mandatory (R61). */
  unknowns: string[];
}

export interface ErrorOptions {
  maxDepth?: number;
  traceLimit?: number;
  sinceDays?: number;
}

export function errorPaths(
  store: FactStore, service: string, method: string, url: string,
  options: ErrorOptions = {},
): ErrorReport {
  const route = store.raw().prepare(
    "SELECT node_id FROM routes WHERE service_name = ? AND method = ? AND url = ?",
  ).get(service, method.toUpperCase(), url) as { node_id: number } | undefined;
  if (!route) throw new Error(`no route ${method.toUpperCase()} ${url} in ${service}`);

  // Pass 1 and pass 2 run independently. Neither reads the other's result;
  // that is what "never merged into one verdict" means in code (R41).
  const observed = erroredTracesFor(store, service, url, options.traceLimit ?? 5)
    .map((t) => traceRootCause(store, t.traceId));
  const staticSurface = staticFailureSurface(store, route.node_id, options.maxDepth);

  const files = [...new Set(staticSurface.map((f) => f.file).filter((f): f is string => !!f))];
  const correlation = correlatedChanges(store, files, options.sinceDays);

  return {
    service, method: method.toUpperCase(), url, routeNodeId: route.node_id,
    observed,
    observedAvailable: store.countRows("spans") > 0,
    staticSurface,
    correlation,
    unknowns: collectUnknowns(store, route.node_id, staticSurface),
  };
}

/**
 * R61's mandatory UNKNOWN section.
 *
 * Every reason this report might be incomplete, named. The list is long on this
 * corpus and that is the honest state: a service with no symbols contributes no
 * failure surface at all, and a report that did not say so would read as
 * "this service cannot fail".
 */
function collectUnknowns(
  store: FactStore, routeNodeId: number, surface: StaticFailure[],
): string[] {
  const out: string[] = [];

  const unresolved = store.raw().prepare(
    `SELECT COUNT(*) AS n FROM unresolved_calls u
      WHERE u.src_node_id IN (
        SELECT rc.symbol_node_id FROM route_chain rc
         WHERE rc.route_node_id = ? AND rc.symbol_node_id IS NOT NULL)`,
  ).get(routeNodeId) as { n: number };
  if (unresolved.n > 0) {
    out.push(
      `${unresolved.n} unresolved call site(s) on this path — anything they reach ` +
      `is outside this surface`,
    );
  }

  const unjoined = store.raw().prepare(
    `SELECT COUNT(*) AS n FROM route_chain
      WHERE route_node_id = ? AND symbol_node_id IS NULL
        AND origin NOT IN ('framework', 'handler')`,
  ).get(routeNodeId) as { n: number };
  if (unjoined.n > 0) {
    out.push(
      `${unjoined.n} chain entr(ies) resolved to no symbol — their failure modes ` +
      `are not represented`,
    );
  }

  const noCfg = store.raw().prepare(
    `SELECT COUNT(*) AS n FROM route_chain rc
      WHERE rc.route_node_id = ? AND rc.symbol_node_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM function_cfg c WHERE c.symbol_node_id = rc.symbol_node_id)`,
  ).get(routeNodeId) as { n: number };
  if (noCfg.n > 0) {
    out.push(
      `${noCfg.n} chain symbol(s) have no control-flow analysis — their error ` +
      `exits are not in this surface`,
    );
  }

  if (surface.length === 0) {
    out.push(
      "the static surface is EMPTY. Read that as 'nothing detected', not as " +
      "'nothing can fail' — see the reasons above.",
    );
  }

  const spans = store.countRows("spans");
  if (spans === 0) {
    out.push(
      "no spans in the store: the OBSERVED section is empty because nothing was " +
      "recorded, not because nothing failed",
    );
  }
  return out;
}
