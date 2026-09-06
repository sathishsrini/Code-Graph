// ============================================================================
// Route chain expander  —  task P1-T8  (requirements R6, R24, R25, R32)
// ============================================================================
// Turns a boot artifact into `routes`, `route_chain` and `HANDLES` edges.
//
// The ordering is the product. Middleware order is the one thing no static
// reader of the source recovers — Fastify synthesises HEAD routes that exist
// in no file (6 of 23 on the router), and Starlette's stack runs in the
// reverse of source order (D14). So `position` is copied from what the
// framework reported and is never recomputed, sorted or normalised here. A
// derivation that re-derives the order is a derivation that can disagree with
// the runtime, and the runtime is the thing being described.
//
// Joining a chain entry to a symbol is the other half. 68% and 89% of entries
// in the two Node services are anonymous arrows (M6), so the join key is
// `file:line`, not a name — the boot adapters report positions for exactly
// this reason. An entry that joins to nothing is stored with a NULL
// `symbol_node_id`, never dropped: the chain must stay complete even where
// the index cannot name a step.
// ============================================================================

import type { BootDump, BootRoute, ChainEntry } from "../boot/dump.ts";
import type { FactStore } from "../store/db.ts";
import type { GraphWriter } from "../normalize/graph.ts";
import { ref } from "../normalize/keys.ts";
import { symbolAt, type DefRange } from "../query/flow.ts";

export interface ExpandOptions {
  store: FactStore;
  writer: GraphWriter;
  repoId: number;
  /** SCIP definition ranges for this repo, from `buildDefinitionRanges`. */
  ranges: DefRange[];
  /** `files.id` by repo-relative path, for provenance (R28). */
  fileIds: Map<string, number>;
  runId: number;
}

export interface ExpandStats {
  routes: number;
  chainEntries: number;
  /** Entries with no SCIP definition covering their line. A gap, not a zero. */
  unjoined: number;
  /** Entries that are the framework's own code — never expected to join. */
  framework: number;
  handlesEdges: number;
}

/**
 * Write one service's boot artifact into the store.
 *
 * R24: boot facts are replaced wholesale per service per run. The boot rows
 * for each route are deleted before re-insert, scoped to `evidence_kind='boot'`
 * so P1-T10's inline-auth rows survive. Merging instead would let a *removed*
 * hook persist — wrong in the one direction that matters for a security answer.
 */
export function expandRoutes(dump: BootDump, options: ExpandOptions): ExpandStats {
  const { store, writer, repoId, ranges, fileIds, runId } = options;
  const stats: ExpandStats = {
    routes: 0, chainEntries: 0, unjoined: 0, framework: 0, handlesEdges: 0,
  };

  const serviceNode = writer.node(ref.service(dump.service));

  for (const route of dump.routes) {
    const routeRef = ref.route(dump.service, route.method, route.url);
    const routeNodeId = writer.node(routeRef);

    // The handler is the last `handler`-phase entry. Named separately from the
    // chain because `routes.handler_node_id` is what `impact` walks back to.
    const handlerEntry = route.chain.find((c) => c.phase === "handler");
    const handlerSymbol = handlerEntry ? joinSymbol(handlerEntry, ranges) : null;

    store.upsertRoute({
      nodeId: routeNodeId,
      repoId,
      serviceName: dump.service,
      method: route.method,
      url: route.url,
      prefix: route.prefix,
      handlerNodeId: handlerSymbol ? writer.node(ref.symbol(handlerSymbol)) : null,
      // OPEN-6: null across this corpus, and stated rather than back-filled.
      requestSchema: null,
      responseSchema: null,
      hasSchema: route.hasSchema,
      source: "boot",
      runId,
    });
    stats.routes += 1;

    // A service CONTAINS its routes. This is what makes "which endpoints does
    // this service expose" a single index scan rather than a string prefix
    // match on route keys.
    writer.edgeById(serviceNode, routeNodeId, "CONTAINS", "certain", "boot");

    store.deleteChain(routeNodeId, ["boot"]);

    for (const entry of route.chain) {
      const symbol = joinSymbol(entry, ranges);
      if (entry.origin === "framework") stats.framework += 1;
      else if (!symbol) stats.unjoined += 1;

      store.insertChainEntry({
        routeNodeId,
        position: entry.position,
        phase: entry.phase,
        symbolNodeId: symbol ? writer.node(ref.symbol(symbol)) : null,
        key: entry.key,
        name: entry.name,
        // check_kind stays null here. Classifying a hook as auth/tenant/rbac
        // is P1-T9's job and is a *reviewed config file*, not something the
        // boot channel should guess from a function name.
        checkKind: null,
        origin: entry.origin,
        inheritedFrom: entry.inheritedFrom,
        confidence: "certain",
        evidenceKind: "boot",
        fileId: entry.file ? fileIds.get(entry.file) ?? null : null,
        line: entry.line,
        runId,
      });
      stats.chainEntries += 1;

      // HANDLES: route -> the symbol that runs on it. Emitted for every chain
      // step, not only the handler, because "what executes on this endpoint"
      // is the question and a hook executes on it too.
      if (symbol) {
        writer.edgeById(
          routeNodeId, writer.node(ref.symbol(symbol)), "HANDLES", "certain", "boot",
          {
            fileId: entry.file ? fileIds.get(entry.file) ?? null : null,
            line: entry.line,
            detail: `${entry.position}:${entry.phase}`,
          },
        );
        stats.handlesEdges += 1;
      }
    }
  }

  return stats;
}

/**
 * The SCIP symbol containing a chain entry's reported position.
 *
 * Returns null rather than a near miss. An anonymous arrow passed straight to
 * `addHook` gets no definition of its own, so this resolves to the enclosing
 * *module* — and rooting a hook at the module attributes every call in the
 * file to it, including `listen` and `process.exit` (M7). `flow` narrows that
 * with `functionExtent`; storage keeps the honest null and lets the query
 * decide.
 */
function joinSymbol(entry: ChainEntry, ranges: DefRange[]): string | null {
  if (!entry.file || entry.line === null) return null;
  if (entry.origin === "framework") return null;
  return symbolAt(ranges, entry.file, entry.line) ?? null;
}

/** Chain rows for one route, in execution order, both channels merged. */
export interface StoredChainRow {
  position: number;
  phase: string;
  name: string | null;
  key: string | null;
  checkKind: string | null;
  origin: string;
  inheritedFrom: string | null;
  confidence: string;
  evidenceKind: string;
  symbolKey: string | null;
  line: number | null;
}

/**
 * Read a route's chain back.
 *
 * Boot phases first in their reported order, then `handler_inline` rows. They
 * are deliberately not interleaved: a boot row is what the framework said and
 * an inline row is what a parser inferred, and presenting them as one
 * undifferentiated list would render an inference as a fact (R26, R50).
 */
export function readChain(store: FactStore, routeNodeId: number): StoredChainRow[] {
  const rows = store.raw().prepare(
    `SELECT rc.position, rc.phase, rc.name, rc.key, rc.check_kind, rc.origin,
            rc.inherited_from, rc.confidence, rc.evidence_kind, rc.line,
            n.key AS symbol_key
       FROM route_chain rc
       LEFT JOIN nodes n ON n.id = rc.symbol_node_id
      WHERE rc.route_node_id = ?
      ORDER BY (rc.phase = 'handler_inline'), rc.position`,
  ).all(routeNodeId) as Array<Record<string, string | number | null>>;

  return rows.map((r) => ({
    position: Number(r["position"]),
    phase: String(r["phase"]),
    name: (r["name"] as string | null) ?? null,
    key: (r["key"] as string | null) ?? null,
    checkKind: (r["check_kind"] as string | null) ?? null,
    origin: String(r["origin"]),
    inheritedFrom: (r["inherited_from"] as string | null) ?? null,
    confidence: String(r["confidence"]),
    evidenceKind: String(r["evidence_kind"]),
    symbolKey: (r["symbol_key"] as string | null) ?? null,
    line: r["line"] === null ? null : Number(r["line"]),
  }));
}
