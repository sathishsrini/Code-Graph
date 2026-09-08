// ============================================================================
// Graph subset -> node+edge JSON  —  task P2-T1  (requirement R45)
// ============================================================================
// The UI's data contract, and deliberately a separate module from the UI.
//
// **Two visual axes, carried as two independent fields.** This is R78's rule
// expressed in the payload rather than left to the renderer:
//
//   confidence  certain | inferred | observed | unresolved   -> line style
//   outcome     success | error_exit | unknown               -> colour
//
// A `REQUESTS` edge is `inferred` (we are unsure the edge exists) while sitting
// on a `success` path (we are sure that branch is the continuation). A renderer
// handed one merged "status" cannot draw that, and a viewer who cannot see the
// difference will read a dashed line as a failure.
//
// **Security provenance is its own field too** (R50). `boot` and `inline` are
// different evidence for the same claim, and a matrix cell that shows a tick
// for both has converted an inference into a fact.
// ============================================================================

import type { FactStore } from "../store/db.ts";
import { endpointFlow, type EndpointFlow, type FlowNode } from "../query/endpoint-flow.ts";
import { readCfg } from "../static/cfg-ingest.ts";
import { displayNameOf } from "../static/scip/symbol.ts";

export interface GraphNode {
  id: string;
  /** service | route | symbol | file | external | datastore | config | gap */
  kind: string;
  label: string;
  /** The verbatim node key. Stable identity, for deep links and re-fetching. */
  key: string;
  /** Compound-node parent for elkjs service swim-lanes (P2-T5). */
  service: string | null;
  file: string | null;
  line: number | null;
  /** Axis 2: only set for nodes whose control flow was analysed. */
  outcome: "success" | "error_exit" | "unknown" | null;
  /** Chain position, when this node is a step on a route's chain. */
  chain: {
    position: number;
    phase: string;
    checkKind: string | null;
    /** R50: which channel said so. Never merged with `checkKind`. */
    channel: "boot" | "inline";
    confidence: string;
    detail: string | null;
  } | null;
  meta: Record<string, string | number | null>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  /** Axis 1. */
  confidence: string;
  /** Weakest edge on the path from the route (R36). */
  pathConfidence: string;
  evidence: string | null;
  label: string | null;
  /** R77: the CFG block this call site sits in, when known. */
  cfgBlock: number | null;
}

export interface GraphPayload {
  route: { key: string; service: string; method: string; url: string };
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Service names present, in first-reached order — the swim-lane order. */
  services: string[];
  /**
   * R61 in the payload. Rendered as its own panel, never as absent nodes: a
   * graph that simply omits what it could not resolve looks complete.
   */
  unknowns: Array<{ symbol: string; target: string | null; reason: string; where: string }>;
  /** Per-function control flow, for P2-T12's branch view. */
  cfg: Record<string, CfgView>;
  legend: typeof LEGEND;
}

export interface CfgView {
  symbol: string;
  blocks: Array<{
    index: number;
    parent: number | null;
    kind: string;
    condition: string | null;
    outcome: string | null;
    exitForm: string | null;
    errorName: string | null;
    startLine: number;
    endLine: number;
  }>;
}

/**
 * The legend travels WITH the data.
 *
 * A viewer that has to be told separately what dashed means is a viewer where
 * someone eventually reads dashed as broken. R78 requires the two axes be
 * distinguishable with a legend that states the difference; shipping it in the
 * payload makes that impossible to forget.
 */
export const LEGEND = {
  confidence: {
    axis: "line style — how sure we are the edge EXISTS",
    certain: "solid — the compiler resolved it",
    observed: "thick — a trace saw it happen",
    inferred: "dashed — a parser guessed it",
    unresolved: "dotted red — a known gap",
  },
  outcome: {
    axis: "colour — whether that path SUCCEEDS or ERRORS",
    success: "green — the success continuation",
    error_exit: "red — this branch exits with an error",
    unknown: "grey — undetermined; NOT the same as success",
  },
  security: {
    axis: "badge — which channel found the check",
    boot: "filled — the framework reported this hook (certain)",
    inline: "outlined — a parser found it in the handler body (inferred)",
  },
} as const;

// ---------------------------------------------------------------------------

export function flowToGraph(store: FactStore, flow: EndpointFlow): GraphPayload {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const services: string[] = [];
  const cfg: Record<string, CfgView> = {};

  const noteService = (name: string | null) => {
    if (name && !services.includes(name)) services.push(name);
  };

  const addNode = (node: GraphNode): GraphNode => {
    const existing = nodes.get(node.id);
    if (existing) return existing;
    nodes.set(node.id, node);
    noteService(node.service);
    return node;
  };

  const addEdge = (e: Omit<GraphEdge, "id">): void => {
    const id = `${e.source}->${e.target}#${e.type}`;
    if (edges.some((x) => x.id === id)) return;
    edges.push({ ...e, id });
  };

  collect(store, flow, addNode, addEdge, cfg);

  return {
    route: {
      key: flow.routeKey, service: flow.service,
      method: flow.method, url: flow.url,
    },
    nodes: [...nodes.values()],
    edges,
    services,
    unknowns: flow.unknown.map((u) => ({
      symbol: u.srcDisplay,
      target: u.targetHint,
      reason: u.reason,
      where: `${u.file ?? "?"}:${u.line ?? "?"}`,
    })),
    cfg,
    legend: LEGEND,
  };
}

function collect(
  store: FactStore,
  flow: EndpointFlow,
  addNode: (n: GraphNode) => GraphNode,
  addEdge: (e: Omit<GraphEdge, "id">) => void,
  cfg: Record<string, CfgView>,
): void {
  const routeId = `route:${flow.routeKey}`;
  addNode({
    id: routeId, kind: "route", label: `${flow.method} ${flow.url}`,
    key: flow.routeKey, service: flow.service, file: null, line: null,
    outcome: null, chain: null, meta: {},
  });

  let previous = routeId;
  for (const step of flow.chain) {
    const isInline = step.phase === "handler_inline";
    const id = isInline
      ? `check:${flow.routeKey}#${step.position}`
      : step.symbolKey
        ? `symbol:${step.symbolKey}`
        : `chain:${flow.routeKey}#${step.phase}#${step.position}`;

    addNode({
      id,
      kind: isInline ? "check" : step.symbolKey ? "symbol" : "chain",
      label: step.name ?? (isInline ? "(shape match)" : "(anonymous)"),
      key: step.symbolKey ?? step.key ?? id,
      service: flow.service,
      file: step.key?.split(":")[0] ?? null,
      line: step.key ? Number(step.key.split(":")[1] ?? 0) || null : null,
      outcome: null,
      chain: {
        position: step.position,
        phase: step.phase,
        checkKind: step.checkKind,
        // R50: never merged with checkKind. "auth" and "who says so" are two
        // facts, and a badge showing only the first renders an inference as
        // a framework guarantee.
        channel: step.evidenceKind === "boot" ? "boot" : "inline",
        confidence: step.confidence,
        detail: step.detail,
      },
      meta: { origin: step.origin, evidence: step.evidenceKind },
    });

    addEdge({
      source: previous, target: id, type: isInline ? "CHECKS" : "CHAIN",
      confidence: step.confidence, pathConfidence: step.confidence,
      evidence: step.evidenceKind, label: step.phase, cfgBlock: null,
    });
    if (!isInline) previous = id;

    if (step.symbolNodeId !== null) attachCfg(store, step.symbolKey, step.symbolNodeId, cfg);
    if (step.tree) walk(step.tree, id);
  }

  function walk(node: FlowNode, parentId: string): void {
    for (const child of node.children) {
      const id = `${child.kind}:${child.key}`;
      addNode({
        id,
        kind: child.kind,
        label: child.display,
        key: child.key,
        // A remote route belongs to ITS service, not the caller's — that is
        // what puts it in the right swim-lane.
        service: child.kind === "route"
          ? child.key.split(" ")[0] ?? null
          : child.kind === "symbol" ? flow.service : null,
        file: child.file,
        line: child.line,
        outcome: null,
        chain: null,
        meta: {
          cycle: child.cycle ? 1 : 0,
          truncated: child.truncated ? 1 : 0,
          boundary: child.boundary ? 1 : 0,
        },
      });

      addEdge({
        source: parentId, target: id, type: child.edgeType ?? "CALLS",
        confidence: child.edge, pathConfidence: child.pathConfidence,
        evidence: null, label: null, cfgBlock: null,
      });

      // P2-T12's branch view has to be available for ANY symbol the viewer can
      // click, not only for chain steps. Attaching it only where the chain
      // touched meant selecting a callee showed no execution paths at all.
      if (child.kind === "symbol") attachCfg(store, child.key, child.nodeId, cfg);

      walk(child, id);
      if (child.remote) collect(store, child.remote, addNode, addEdge, cfg);
    }
  }
}

/** Attach one symbol's control flow, so P2-T12 can draw its branches. */
function attachCfg(
  store: FactStore, symbolKey: string | null, symbolNodeId: number,
  cfg: Record<string, CfgView>,
): void {
  if (!symbolKey || cfg[symbolKey]) return;
  const blocks = readCfg(store, symbolNodeId);
  if (blocks.length === 0) return;
  cfg[symbolKey] = {
    symbol: displayNameOf(symbolKey),
    blocks: blocks.map((b) => ({
      index: b.blockIndex, parent: b.parentIndex, kind: b.kind,
      condition: b.conditionText, outcome: b.outcome, exitForm: b.exitForm,
      errorName: b.errorName, startLine: b.startLine, endLine: b.endLine,
    })),
  };
}

/** Convenience: resolve a route and serialise it in one call. */
export function routeGraph(
  store: FactStore, service: string, method: string, url: string,
  options: { maxDepth?: number; followRemote?: boolean } = {},
): GraphPayload {
  return flowToGraph(store, endpointFlow(store, service, method, url, options));
}
